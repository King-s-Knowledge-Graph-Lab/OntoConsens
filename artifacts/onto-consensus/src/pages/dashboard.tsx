import { Link, useLocation } from "wouter";
import { useListProjects, useCreateProject, useJoinProject, useDeleteProject, useGetMe, useLogout, useUpdateApiKey, getListProjectsQueryKey, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { clearAuthToken } from "@/lib/authToken";
import { useDashboardSocket } from "@/hooks/useDashboardSocket";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Network, Plus, Users, ArrowRight, FolderPlus, Trash2, LogOut, Upload, FileText, Copy, Check, KeyRound, Loader2, Sparkles } from "lucide-react";

const apiKeySchema = z.object({
  apiKey: z.string().min(1, "An OpenAI API key is required"),
});

const createSchema = z.object({
  name: z.string().min(1, "Project name is required").max(100, "Project name is too long"),
  file: z.instanceof(File, { message: "Ontology file is required" }),
  memberCount: z.enum(["2", "3"], { message: "Choose how many members this project is for" }),
  // Locked in at creation -- there is no route to change it afterward, so
  // this is the only place it's ever chosen.
  moderatorEnabled: z.boolean(),
});

const joinSchema = z.object({
  inviteCode: z.string().min(1, "Invite code is required"),
});

export default function Dashboard() {
  const { data: projects, isLoading } = useListProjects();
  const { data: me } = useGetMe();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [, setLocation] = useLocation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [copiedProjectId, setCopiedProjectId] = useState<number | null>(null);

  const handleCopyCode = (e: React.MouseEvent, projectId: number, inviteCode: string) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(inviteCode);
    setCopiedProjectId(projectId);
    setTimeout(() => setCopiedProjectId((current) => (current === projectId ? null : current)), 1500);
  };

  const createProject = useCreateProject();
  const joinProject = useJoinProject();
  const deleteProject = useDeleteProject();
  const logout = useLogout();
  const updateApiKey = useUpdateApiKey();
  const queryClient = useQueryClient();

  const apiKeyForm = useForm<z.infer<typeof apiKeySchema>>({
    resolver: zodResolver(apiKeySchema),
    defaultValues: { apiKey: "" },
  });

  const onApiKeySubmit = (values: z.infer<typeof apiKeySchema>) => {
    updateApiKey.mutate(
      { data: { apiKey: values.apiKey } },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(getGetMeQueryKey(), (old: any) => ({
            ...old,
            apiKeyConfigured: data.apiKeyConfigured,
          }));
          setApiKeyOpen(false);
          apiKeyForm.reset();
        },
        onError: (err: any) => {
          apiKeyForm.setError("root", { message: err?.data?.error || "Could not save that key." });
          setTimeout(() => apiKeyForm.clearErrors("root"), 1500);
        },
      },
    );
  };

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSettled: () => {
        clearAuthToken();
        queryClient.clear();
        setLocation("/login");
      },
    });
  };

  // Shared by this tab's own optimistic delete and by the realtime push that
  // arrives when a co-member deletes the project from elsewhere.
  const removeProjectFromCache = (id: number) => {
    queryClient.setQueryData(getListProjectsQueryKey(), (old: any) =>
      Array.isArray(old) ? old.filter((p: any) => p.id !== id) : old,
    );
  };

  // Other members of a shared project aren't necessarily looking at it when
  // its owner deletes it, or when someone else joins it -- they may be
  // sitting right here on the dashboard. This keeps a lightweight realtime
  // connection open so both cases update immediately too, instead of only
  // on the next full page load.
  useDashboardSocket({
    enabled: Boolean(me),
    onProjectDeleted: removeProjectFromCache,
    onMemberCountChanged: (projectId, memberCount) => {
      queryClient.setQueryData(getListProjectsQueryKey(), (old: any) =>
        Array.isArray(old)
          ? old.map((p: any) => (p.id === projectId ? { ...p, memberCount } : p))
          : old,
      );
    },
  });

  const handleDeleteProject = (id: number) => {
    // Optimistic removal: the card must vanish the instant the button is
    // clicked, not after a round trip to the server. Strip it from the
    // cached list immediately (and remember the previous list in case the
    // request fails), then fire the actual mutation in the background.
    const previousProjects = queryClient.getQueryData(getListProjectsQueryKey());
    removeProjectFromCache(id);
    deleteProject.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        },
        onError: (err: any) => {
          console.error("Failed to delete project", err);
          // Roll back -- the delete didn't actually happen, so put the
          // project's card back instead of leaving it silently missing.
          queryClient.setQueryData(getListProjectsQueryKey(), previousProjects);
        },
      },
    );
  };

  const createForm = useForm<z.infer<typeof createSchema>>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", memberCount: "2", moderatorEnabled: true },
  });

  const joinForm = useForm<z.infer<typeof joinSchema>>({
    resolver: zodResolver(joinSchema),
    defaultValues: { inviteCode: "" },
  });

  // Client-side validation failures (missing name/file, bad member count) are
  // set by the zod resolver itself, not inside onCreateSubmit -- handleSubmit's
  // second argument fires exactly once whenever that happens, so this is the
  // one place to schedule their auto-dismiss.
  const onCreateInvalid = () => {
    setTimeout(() => createForm.clearErrors(["name", "file", "memberCount"]), 1000);
  };

  const onCreateSubmit = (values: z.infer<typeof createSchema>) => {
    createProject.mutate(
      {
        data: {
          name: values.name,
          file: values.file,
          memberCount: Number(values.memberCount),
          moderatorEnabled: values.moderatorEnabled,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          setCreateOpen(false);
          createForm.reset();
        },
        onError: (err: any) => {
          const message = err?.data?.error;
          if (message === "Project name already exists") {
            createForm.setError("name", { message: "This project name already exists" });
            setTimeout(() => createForm.clearErrors("name"), 1000);
          } else {
            createForm.setError("root", { message: message || "Failed to create project." });
            setTimeout(() => createForm.clearErrors("root"), 1000);
          }
        }
      }
    );
  };

  const onJoinSubmit = (values: z.infer<typeof joinSchema>) => {
    joinProject.mutate(
      { data: values },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          setJoinOpen(false);
          joinForm.reset();
        },
        onError: () => {
          joinForm.setError("root", { message: "No project found" });
          setTimeout(() => joinForm.clearErrors("root"), 1000);
        }
      }
    );
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="sticky top-0 z-30 w-full border-b bg-card/80 backdrop-blur-md">
        <div className="container mx-auto px-3 sm:px-4 py-2 sm:h-16 sm:py-0 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center shrink-0">
              <Network className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-mono font-bold text-lg">OntoConsens</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <ArrowRight className="w-4 h-4" />
                  <span className="hidden sm:inline">Join Project</span>
                  <span className="sm:hidden">Join</span>
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Join a Project</DialogTitle>
                </DialogHeader>
                <Form {...joinForm}>
                  <form onSubmit={joinForm.handleSubmit(onJoinSubmit)} className="space-y-4">
                    <FormField
                      control={joinForm.control}
                      name="inviteCode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Invite Code</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    {joinForm.formState.errors.root && (
                      <p className="text-sm font-medium text-destructive">
                        {joinForm.formState.errors.root.message}
                      </p>
                    )}
                    <DialogFooter>
                      <Button type="submit" disabled={joinProject.isPending}>Join</Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>

            <Dialog
              open={createOpen}
              onOpenChange={(open) => {
                if (createProject.isPending) return;
                setCreateOpen(open);
              }}
            >
              <DialogTrigger asChild>
                <Button size="sm" className="gap-2">
                  <Plus className="w-4 h-4" />
                  <span className="hidden sm:inline">New Project</span>
                  <span className="sm:hidden">New</span>
                </Button>
              </DialogTrigger>
              <DialogContent closeButtonDisabled={createProject.isPending}>
                <DialogHeader>
                  <DialogTitle>Create New Project</DialogTitle>
                </DialogHeader>
                <Form {...createForm}>
                  <form onSubmit={createForm.handleSubmit(onCreateSubmit, onCreateInvalid)} className="space-y-4">
                    <FormField
                      control={createForm.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Project Name</FormLabel>
                          <FormControl>
                            <Input {...field} disabled={createProject.isPending} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={createForm.control}
                      name="memberCount"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Number of Members</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value} disabled={createProject.isPending}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Select number of members" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="2">2 members</SelectItem>
                              <SelectItem value="3">3 members</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={createForm.control}
                      name="file"
                      render={({ field: { value, onChange, ref, ...fieldProps } }) => {
                        const selectedFile = value instanceof File ? value : undefined;
                        return (
                          <FormItem>
                            <FormLabel>Ontology File</FormLabel>
                            <FormControl>
                              <div>
                                <input
                                  type="file"
                                  className="sr-only"
                                  disabled={createProject.isPending}
                                  ref={(el) => {
                                    fileInputRef.current = el;
                                    ref(el);
                                  }}
                                  onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) onChange(file);
                                  }}
                                  {...fieldProps}
                                />
                                <button
                                  type="button"
                                  disabled={createProject.isPending}
                                  onClick={() => fileInputRef.current?.click()}
                                  className="flex w-full items-center gap-3 rounded-md border border-dashed border-input bg-transparent px-3 py-3 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                                >
                                  {selectedFile ? (
                                    <>
                                      <FileText className="w-4 h-4 shrink-0 text-primary" />
                                      <span className="truncate font-medium">{selectedFile.name}</span>
                                    </>
                                  ) : (
                                    <>
                                      <Upload className="w-4 h-4 shrink-0 text-muted-foreground" />
                                      <span className="text-muted-foreground">Click to select a file</span>
                                    </>
                                  )}
                                </button>
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        );
                      }}
                    />
                    <FormField
                      control={createForm.control}
                      name="moderatorEnabled"
                      render={({ field }) => (
                        <FormItem className="flex flex-col items-center justify-center gap-2 rounded-md border border-input px-3 py-3 text-center">
                          <FormLabel className="text-sm">AI Moderator</FormLabel>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                              disabled={createProject.isPending}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    {createForm.formState.errors.root && (
                      <p className="text-sm font-medium text-destructive">
                        {createForm.formState.errors.root.message}
                      </p>
                    )}
                    <DialogFooter>
                      <Button type="submit" disabled={createProject.isPending} className="gap-2">
                        {createProject.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                        Create
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>

            <Dialog open={apiKeyOpen} onOpenChange={setApiKeyOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <KeyRound className="w-4 h-4" />
                  <span className="hidden sm:inline">API Key</span>
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Update your OpenAI API key</DialogTitle>
                </DialogHeader>
                <Form {...apiKeyForm}>
                  <form onSubmit={apiKeyForm.handleSubmit(onApiKeySubmit)} className="space-y-4">
                    <FormField
                      control={apiKeyForm.control}
                      name="apiKey"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <Input type="password" placeholder="sk-..." autoComplete="off" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {apiKeyForm.formState.errors.root && (
                      <p className="text-sm font-medium text-destructive">
                        {apiKeyForm.formState.errors.root.message}
                      </p>
                    )}
                    <DialogFooter>
                      <Button type="submit" disabled={updateApiKey.isPending} className="gap-2">
                        {updateApiKey.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                        Save
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>

            <Button
              variant="outline"
              size="icon"
              onClick={handleLogout}
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8">
        <div className="mb-8 space-y-2">
          {me && (
            <p className="text-3xl font-bold tracking-tight">Hello, {me.username}</p>
          )}
          <h1 className="text-3xl font-bold tracking-tight">Your Projects</h1>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="h-48 animate-pulse bg-muted" />
            ))}
          </div>
        ) : projects?.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 text-center border-2 border-dashed rounded-xl bg-card">
            <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
              <FolderPlus className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">No projects yet</h3>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects?.map((project) => (
              <div key={project.id} className="relative group">
                <Link href={`/projects/${project.id}`}>
                  <Card className="h-full hover:border-primary/50 transition-colors cursor-pointer hover:shadow-md">
                    <CardHeader>
                      <CardTitle className="group-hover:text-primary transition-colors line-clamp-1 pr-6">{project.name}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Users className="w-4 h-4" />
                        <span>{project.memberCount} / {project.maxMembers} members</span>
                      </div>
                      <div
                        className={`flex items-center gap-2 text-sm ${
                          project.moderatorEnabled ? "text-muted-foreground" : "text-muted-foreground/50"
                        }`}
                      >
                        <Sparkles className="w-4 h-4" />
                        <span>AI moderator {project.moderatorEnabled ? "enabled" : "disabled"}</span>
                      </div>
                    </CardContent>
                    <CardFooter className="pt-4 border-t bg-muted/20">
                      <button
                        type="button"
                        onClick={(e) => handleCopyCode(e, project.id, project.inviteCode)}
                        className="flex items-center gap-1.5 text-xs font-mono bg-background px-2 py-1 rounded border hover:bg-accent hover:text-accent-foreground transition-colors"
                      >
                        {copiedProjectId === project.id ? (
                          <>
                            <Check className="w-3 h-3" />
                            Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            Code: {project.inviteCode}
                          </>
                        )}
                      </button>
                    </CardFooter>
                  </Card>
                </Link>
                {/* Only the creator can delete a project; doing so removes it
                    for every member. Stops propagation so it never triggers
                    the card's own navigation link. */}
                {me && project.ownerId === me.id && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute top-3 right-3 h-7 w-7 text-muted-foreground opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-opacity"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete "{project.name}"?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This permanently deletes the project for every member and cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleDeleteProject(project.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
