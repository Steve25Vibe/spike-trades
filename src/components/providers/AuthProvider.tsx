'use client';

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { useRouter } from 'next/navigation';

interface AuthState {
  authenticated: boolean;
  email: string | null;
  role: 'admin' | 'user' | null;
  mustChangePassword: boolean;
  loading: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  authenticated: false,
  email: null,
  role: null,
  mustChangePassword: false,
  loading: true,
  logout: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<AuthState, 'logout' | 'loading'>>({
    authenticated: false,
    email: null,
    role: null,
    mustChangePassword: false,
  });
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    fetch('/api/auth')
      .then((r) => r.json())
      .then((json) => {
        setState({
          authenticated: json.authenticated || false,
          email: json.email || null,
          role: json.role || null,
          mustChangePassword: json.mustChangePassword || false,
        });
      })
      .catch(() => {
        setState({ authenticated: false, email: null, role: null, mustChangePassword: false });
      })
      .finally(() => setLoading(false));
  }, []);

  const logout = useCallback(async () => {
    await fetch('/api/auth', { method: 'DELETE' });
    setState({ authenticated: false, email: null, role: null, mustChangePassword: false });
    router.push('/login');
  }, [router]);

  return (
    <AuthContext.Provider value={{ ...state, loading, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
