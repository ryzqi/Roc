import type React from 'react';
import { useMemo } from 'react';
import { AppShell } from './app/AppShell';
import { useAppBootstrap } from './app/use-app-bootstrap';
import { createRocClient } from './shared/roc-client';

export function App(): React.JSX.Element {
  const client = useMemo(() => createRocClient(), []);
  const bootstrap = useAppBootstrap(client);

  return <AppShell bootstrap={bootstrap} client={client} />;
}
