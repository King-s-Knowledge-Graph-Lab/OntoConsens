import { useEffect } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { getGetMeQueryKey, useGetMe } from "@workspace/api-client-react";
import { clearAuthToken } from "@/lib/authToken";

// An account can only be signed in in one place: logging in elsewhere
// invalidates this tab's token server-side straight away. Polling /auth/me
// on a short interval (rather than only checking once on mount, or waiting
// for the next unrelated request to happen to 401) is what actually notices
// that and kicks this tab back to the login page promptly.
const SESSION_CHECK_INTERVAL_MS = 3000;

export function useAuth() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { data: user, isLoading, error } = useGetMe({
    query: {
      retry: false,
      queryKey: getGetMeQueryKey(),
      refetchInterval: SESSION_CHECK_INTERVAL_MS,
    }
  });

  const isAuthenticated = !!user;

  useEffect(() => {
    if ((error as any)?.status === 401) {
      clearAuthToken();
      queryClient.clear();
      setLocation("/login");
    }
  }, [error, queryClient, setLocation]);

  return {
    user,
    isLoading,
    isAuthenticated,
    error,
  };
}

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      setLocation("/login");
    }
  }, [isLoading, isAuthenticated, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return isAuthenticated ? <>{children}</> : null;
}
