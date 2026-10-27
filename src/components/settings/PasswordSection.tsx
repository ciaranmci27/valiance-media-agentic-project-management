'use client';

import { useState } from 'react';
import { Lock } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { toast } from '@/components/ui/Toast';

/** Sets a new login password through Supabase auth. */
export function PasswordSection() {
  const supabase = createClient();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  const handleChangePassword = async () => {
    if (newPassword.length < 6) {
      toast('error', 'Password must be at least 6 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast('error', 'Passwords do not match');
      return;
    }

    setPasswordLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setNewPassword('');
      setConfirmPassword('');
      toast('success', 'Password updated successfully');
    } catch (err) {
      toast('error', (err as { message?: string } | null)?.message || 'Failed to update password');
    } finally {
      setPasswordLoading(false);
    }
  };

  return (
    <section id="password" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-rose-500/15 rounded-lg">
          <Lock className="text-rose-400" size={20} />
        </div>
        <div>
          <h2 className="font-semibold text-white">Change Password</h2>
          <p className="text-sm text-zinc-400">Update your account password</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input
          label="New Password"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="Min. 6 characters"
        />
        <Input
          label="Confirm Password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Re-enter password"
        />
      </div>

      <div className="mt-4">
        <Button onClick={handleChangePassword} disabled={passwordLoading}>
          {passwordLoading ? 'Updating...' : 'Update Password'}
        </Button>
      </div>
    </section>
  );
}
