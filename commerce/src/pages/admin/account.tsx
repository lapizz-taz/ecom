import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, LogOut, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/auth-context'
import { supabase } from '@/lib/supabase'
import { updateMyProfile } from '@/services/users'

export default function AccountPage() {
  const { user, access, signOut } = useAuth()
  const navigate = useNavigate()
  const permissions = access?.role === 'OWNER' ? ['Every permission (owner)'] : access?.permissions ?? []
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="Your account" description={user?.email} actions={
        <Button variant="outline" size="sm" onClick={async () => { await signOut(); navigate('/admin/login') }}><LogOut /> Sign out</Button>
      } />
      <Profile />
      <ChangePassword />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your access</CardTitle>
          <CardDescription>Role: <Badge variant="secondary">{access?.role_name}</Badge> — ask an owner if you need more.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1.5">
          {permissions.map((p) => <code key={p} className="rounded bg-muted px-1.5 py-0.5 text-xs">{p}</code>)}
        </CardContent>
      </Card>
    </div>
  )
}

function Profile() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const profile = useQuery({
    queryKey: ['my-profile', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('full_name, phone').eq('id', user!.id).single()
      if (error) throw error
      return data
    },
  })
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  useEffect(() => {
    if (profile.data) { setName(profile.data.full_name ?? ''); setPhone(profile.data.phone ?? '') }
  }, [profile.data])
  const save = useMutation({
    mutationFn: () => updateMyProfile(name.trim(), phone.trim()),
    onSuccess: () => {
      toast.success('Profile saved')
      void queryClient.invalidateQueries({ queryKey: ['my-profile'] })
      void queryClient.invalidateQueries({ queryKey: ['my-access'] })
      void queryClient.invalidateQueries({ queryKey: ['staff-directory'] })
    },
  })
  const dirty = !!profile.data && (name !== (profile.data.full_name ?? '') || phone !== (profile.data.phone ?? ''))
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Profile</CardTitle><CardDescription>Your name appears on order history, notes and the audit log.</CardDescription></CardHeader>
      <CardContent>
        {profile.isLoading ? <LoadingState /> : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" htmlFor="acc-name" required><Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Phone" htmlFor="acc-phone"><Input id="acc-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          </div>
        )}
      </CardContent>
      <CardFooter className="justify-end border-t">
        <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || name.trim().length < 2 || save.isPending}>{save.isPending ? <Spinner /> : <Save />} Save</Button>
      </CardFooter>
    </Card>
  )
}

function ChangePassword() {
  const { user } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const change = useMutation({
    mutationFn: async () => {
      // Re-authenticate first so a session left open on a shared device cannot change the password.
      const check = await supabase.auth.signInWithPassword({ email: user!.email!, password: current })
      if (check.error) throw new Error('VALIDATION: your current password is incorrect')
      const { error } = await supabase.auth.updateUser({ password: next })
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Password changed')
      setCurrent(''); setNext(''); setConfirm('')
    },
  })
  const mismatch = confirm.length > 0 && confirm !== next
  const tooShort = next.length > 0 && next.length < 10
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Password</CardTitle></CardHeader>
      <CardContent>
        <form id="pw-form" className="grid gap-4 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); change.mutate() }}>
          <Field label="Current password" htmlFor="pw-current"><Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
          <Field label="New password" htmlFor="pw-new" error={tooShort ? 'At least 10 characters' : undefined}><Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          <Field label="Repeat new password" htmlFor="pw-confirm" error={mismatch ? 'Passwords do not match' : undefined}><Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        </form>
      </CardContent>
      <CardFooter className="justify-end border-t">
        <Button size="sm" type="submit" form="pw-form" disabled={!current || next.length < 10 || next !== confirm || change.isPending}>
          {change.isPending ? <Spinner /> : <KeyRound />} Change password
        </Button>
      </CardFooter>
    </Card>
  )
}
