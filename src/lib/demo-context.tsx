'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
interface DemoContextType {
  isDemoMode: boolean;
  isEnvForcedDemo: boolean;
  toggleDemoMode: () => void;
}

const DemoContext = createContext<DemoContextType | undefined>(undefined);

const STORAGE_KEY = 'valiance-demo-mode';
const ENV_FORCED = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

export function DemoProvider({ children }: { children: ReactNode }) {
  const [isDemoMode, setIsDemoMode] = useState(ENV_FORCED);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!ENV_FORCED) {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'true') {
        setIsDemoMode(true);
      }
    }
    setHydrated(true);
  }, []);

  const toggleDemoMode = () => {
    if (ENV_FORCED) return;
    setIsDemoMode(prev => {
      const next = !prev;
      if (next) {
        localStorage.setItem(STORAGE_KEY, 'true');
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
      return next;
    });
  };

  if (!hydrated) return null;

  return (
    <DemoContext.Provider value={{ isDemoMode, isEnvForcedDemo: ENV_FORCED, toggleDemoMode }}>
      {children}
    </DemoContext.Provider>
  );
}

export function useDemo() {
  const context = useContext(DemoContext);
  if (!context) {
    throw new Error('useDemo must be used within a DemoProvider');
  }
  return context;
}
