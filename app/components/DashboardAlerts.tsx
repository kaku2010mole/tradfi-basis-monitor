'use client';

import { usePathname } from 'next/navigation';
import GlobalOracleAlerts from './GlobalOracleAlerts';

export default function DashboardAlerts() {
  const path = usePathname();
  return path?.startsWith('/luxury') ? null : <GlobalOracleAlerts />;
}
