import type React from 'react';
import { useEffect, useMemo } from 'react';
import { AppShell } from './app/AppShell';
import { useAppBootstrap } from './app/use-app-bootstrap';
import { createRocClient } from './shared/roc-client';
import { bindWindowVisibility } from './window-visibility';

export function App(): React.JSX.Element {
  const client = useMemo(() => createRocClient(), []);
  const bootstrap = useAppBootstrap(client);

  useEffect(() => bindWindowVisibility(client), [client]);

  return <AppShell bootstrap={bootstrap} client={client} />;
}
