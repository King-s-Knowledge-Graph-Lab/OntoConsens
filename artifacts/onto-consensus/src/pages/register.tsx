import { Link, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useRegister, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { setAuthToken } from "@/lib/authToken";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Network } from "lucide-react";

const registerSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters").max(32, "Username too long"),
  password: z.string().min(6, "Password must be at least 6 characters").max(128, "Password too long"),
  confirmPassword: z.string(),
  apiKey: z.string().min(1, "An OpenAI API key is required"),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

export default function Register() {
  const [, setLocation] = useLocation();
  const register = useRegister();
  const queryClient = useQueryClient();

  const form = useForm<z.infer<typeof registerSchema>>({
    resolver: zodResolver(registerSchema),
    // Errors should only ever appear right after clicking "Create account",
    // never live while typing -- the default `reValidateMode` is "onChange",
    // which (once a first submit has failed) would re-run validation and
    // pop errors back up on every keystroke. Pinning both modes to
    // "onSubmit" means validation, and therefore any visible error, only
    // ever runs as a direct result of a submit click.
    mode: "onSubmit",
    reValidateMode: "onSubmit",
    defaultValues: {
      username: "",
      password: "",
      confirmPassword: "",
      apiKey: "",
    },
  });

  // Client-side validation failures (too short, passwords don't match) are
  // set by the zod resolver itself, not by this component -- `handleSubmit`'s
  // second argument fires exactly once whenever that happens, so this is the
  // one place to schedule their auto-dismiss, mirroring the explicit
  // setTimeout used for the server-reported errors below.
  function onInvalid() {
    setTimeout(() => form.clearErrors(["username", "password", "confirmPassword", "apiKey"]), 1000);
  }

  function onSubmit(values: z.infer<typeof registerSchema>) {
    register.mutate(
      { data: { username: values.username, password: values.password, apiKey: values.apiKey } },
      {
        onSuccess: (data) => {
          setAuthToken(data.token);
          queryClient.setQueryData(getGetMeQueryKey(), {
            id: data.id,
            username: data.username,
            apiKeyConfigured: data.apiKeyConfigured,
          });
          setLocation("/");
        },
        onError: (error: any) => {
          const message = error?.data?.error;
          if (message === "Username already taken") {
            form.setError("username", { message: "This username is already taken" });
            setTimeout(() => form.clearErrors("username"), 1000);
          } else {
            form.setError("root", {
              message: message || "An error occurred during registration.",
            });
            setTimeout(() => form.clearErrors("root"), 1000);
          }
        },
      }
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center justify-center space-y-2">
          <div className="w-12 h-12 bg-primary rounded-xl flex items-center justify-center shadow-lg">
            <Network className="w-6 h-6 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground font-mono">OntoConsens</h1>
        </div>

        <Card className="border-border/50 shadow-xl shadow-black/5">
          <CardHeader className="space-y-1 text-center">
            <CardTitle className="text-xl">Create an account</CardTitle>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Username</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <Input type="password" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Confirm Password</FormLabel>
                      <FormControl>
                        <Input type="password" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="apiKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>OpenAI API Key</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="sk-..." autoComplete="off" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {form.formState.errors.root && (
                  <p className="text-sm font-medium text-destructive">
                    {form.formState.errors.root.message}
                  </p>
                )}
                <Button type="submit" className="w-full" disabled={register.isPending}>
                  {register.isPending ? "Creating account..." : "Create account"}
                </Button>
              </form>
            </Form>
          </CardContent>
          <CardFooter className="flex justify-center border-t border-border/50 pt-6">
            <p className="text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="text-primary font-medium hover:underline">
                Sign in
              </Link>
            </p>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
