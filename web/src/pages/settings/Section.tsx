import type { ReactNode } from 'react';
import { Card } from '../../components/Card';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return <Card title={title} className="mb-6" bodyClassName="space-y-3 p-4">{children}</Card>;
}
