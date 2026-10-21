import { useState } from 'react';
import { motion } from 'motion/react';
import { AdminUserManager } from './AdminUserManager';
import { AuditLogs } from './AuditLogs';

export function SettingsManager() {
  const [tab, setTab] = useState<'admin' | 'logs'>('admin');
  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-4 border-b border-line">
        {(['admin', 'logs'] as const).map(value => (
          <button key={value} type="button" onClick={() => setTab(value)} className={`ui-button pb-4 px-2 text-sm font-medium relative ${tab === value ? 'text-brand' : 'text-muted hover:text-ink'}`}>
            {value === 'admin' ? 'Administrador' : 'Logs'}
            {tab === value && <motion.div layoutId="activeSetup" className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand" />}
          </button>
        ))}
      </div>
      {tab === 'admin' ? <AdminUserManager /> : <AuditLogs />}
    </motion.div>
  );
}
