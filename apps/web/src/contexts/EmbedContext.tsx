'use client';

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';

interface EmbedContextValue {
  /** True when the app is loaded inside an iframe with ?embedded=true. */
  isEmbedded: boolean;
}

const EmbedContext = createContext<EmbedContextValue>({ isEmbedded: false });

export function useEmbedMode(): EmbedContextValue {
  return useContext(EmbedContext);
}

export function EmbedModeProvider({ children }: { children: ReactNode }) {
  const [isEmbedded, setIsEmbedded] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsEmbedded(
      params.get('embedded') === 'true' || window.self !== window.top
    );
  }, []);

  return (
    <EmbedContext.Provider value={{ isEmbedded }}>
      {children}
    </EmbedContext.Provider>
  );
}
