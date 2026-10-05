import { useEffect, useRef, useState } from "react";

interface UseModeratorAudioOptions {
  projectId: number;
  /** Mic capture only runs while this is true (moderator on AND user opted in). */
  active: boolean;
  /** Called ~8x/second with a 0..1 volume level while active, for the
   *  per-member "speaking" indicator. */
  onVolume: (level: number) => void;
  /** Streams one resampled PCM16/24kHz audio chunk to the server, which
   *  forwards it into this member's OpenAI realtime transcription session
   *  (see useProjectSocket / wsHub.ts / realtimeTranscription.ts) --
   *  transcription itself, and persisting each finalized utterance, all
   *  happen server-side now. */
  sendAudioChunk: (chunk: Int16Array) => void;
  /** Tells the server to open this member's transcription session. Called
   *  once mic access is granted. */
  sendMicStart: () => void;
  /** Tells the server to close this member's transcription session. Called
   *  as a fallback on unmount/mic-error -- the toggle-off flow itself calls
   *  the same underlying function directly (via useProjectSocket) and
   *  awaits its ack before deactivating, see ModeratorChatPanel's
   *  handleToggleClick. Fire-and-forget from here. */
  sendMicStop: () => void;
}

const VOLUME_SEND_INTERVAL_MS = 120;

// OpenAI's realtime transcription API expects mono PCM16 samples at this
// rate -- the mic's actual hardware rate (commonly 48000 or 44100) is
// downsampled to it client-side (see Resampler below) before every chunk is
// sent, since resampling on the server would mean shipping 2x+ the audio
// data for no benefit.
const TARGET_SAMPLE_RATE = 24000;
// ScriptProcessorNode's buffer size, in samples, at the mic's native rate --
// ~85ms of audio per chunk at 48kHz. Small enough that captions still feel
// live, large enough not to flood the socket with tiny frames.
const PROCESSOR_BUFFER_SIZE = 4096;

// Linear-interpolation resampler that carries its fractional read position
// across calls, since ScriptProcessorNode delivers audio in a continuous
// stream of fixed-size buffers rather than all at once. Deliberately simple
// (no anti-aliasing filter) -- adequate for speech transcription, which
// doesn't need studio-grade resampling quality.
class Resampler {
  private ratio: number;
  private pos = 0;

  constructor(inputRate: number, outputRate: number) {
    this.ratio = inputRate / outputRate;
  }

  process(input: Float32Array): Int16Array {
    const outLength = Math.max(0, Math.floor((input.length - this.pos) / this.ratio));
    const out = new Int16Array(outLength);
    let readPos = this.pos;
    for (let i = 0; i < outLength; i++) {
      const idx = Math.floor(readPos);
      const frac = readPos - idx;
      const s0 = input[idx] ?? 0;
      const s1 = input[idx + 1] ?? s0;
      const sample = s0 + (s1 - s0) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      readPos += this.ratio;
    }
    this.pos = readPos - input.length;
    return out;
  }
}

// Captures this member's mic once (single getUserMedia/AudioContext for
// both the volume meter and the audio stream sent for transcription -- the
// old browser-SpeechRecognition version needed a second, separate mic
// access because the recognizer managed its own internally; that's gone now
// that transcription happens server-side), and streams resampled PCM16
// audio up for the server to transcribe.
export function useModeratorAudio({
  projectId,
  active,
  onVolume,
  sendAudioChunk,
  sendMicStart,
  sendMicStop,
}: UseModeratorAudioOptions) {
  const [micError, setMicError] = useState<string | null>(null);

  const onVolumeRef = useRef(onVolume);
  onVolumeRef.current = onVolume;
  const sendAudioChunkRef = useRef(sendAudioChunk);
  sendAudioChunkRef.current = sendAudioChunk;
  const sendMicStartRef = useRef(sendMicStart);
  sendMicStartRef.current = sendMicStart;
  const sendMicStopRef = useRef(sendMicStop);
  sendMicStopRef.current = sendMicStop;

  useEffect(() => {
    if (!active) return;

    let stopped = false;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let processor: ScriptProcessorNode | null = null;
    let rafId: number | null = null;
    let lastVolumeSentAt = 0;
    let micStarted = false;

    function tick() {
      if (stopped || !analyser) return;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const normalized = (data[i]! - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / data.length);

      const now = Date.now();
      if (now - lastVolumeSentAt >= VOLUME_SEND_INTERVAL_MS) {
        lastVolumeSentAt = now;
        // Normal speech RMS is a small fraction of full scale — scale up so
        // the speaking indicator visibly pulses instead of barely moving.
        onVolumeRef.current(Math.min(1, rms * 4));
      }

      rafId = requestAnimationFrame(tick);
    }

    (async () => {
      try {
        // Explicit (not just relying on browser defaults) so the mic capture
        // reliably cancels echo from whatever's playing on this machine's
        // speakers -- e.g. a separate voice call (Zoom/Meet/Discord) running
        // alongside this app -- rather than transcribing it back as if the
        // local member had said it themselves.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch {
        if (!stopped) setMicError("Microphone access was denied or unavailable.");
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      setMicError(null);
      audioCtx = new AudioContext();
      source = audioCtx.createMediaStreamSource(stream);

      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      const resampler = new Resampler(audioCtx.sampleRate, TARGET_SAMPLE_RATE);
      // ScriptProcessorNode is deprecated in favor of AudioWorkletNode, but
      // remains supported in every current browser and needs no separate
      // module file to load -- the simpler, more reliable choice here.
      processor = audioCtx.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
      processor.onaudioprocess = (e) => {
        if (stopped) return;
        const input = e.inputBuffer.getChannelData(0);
        const pcm = resampler.process(input);
        if (pcm.length > 0) sendAudioChunkRef.current(pcm);
        // Deliberately never write to e.outputBuffer -- it stays silent by
        // default, so connecting to destination below (required in some
        // browsers to keep onaudioprocess firing at all) never causes any
        // audible playback/feedback.
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);

      micStarted = true;
      sendMicStartRef.current();

      rafId = requestAnimationFrame(tick);
    })();

    return () => {
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (processor) {
        processor.onaudioprocess = null;
        try {
          processor.disconnect();
        } catch {
          // already disconnected
        }
      }
      try {
        source?.disconnect();
      } catch {
        // already disconnected
      }
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close().catch(() => {});
      // Fallback teardown for paths other than the explicit toggle-off click
      // (mic error, unmount) -- the toggle-off flow itself awaits the real
      // ack via useProjectSocket's sendMicStop directly (see
      // ModeratorChatPanel), so a duplicate call here is harmless
      // (closeTranscriptionSession is a no-op if the session is already
      // gone).
      if (micStarted) sendMicStopRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, active]);

  return { micError };
}
