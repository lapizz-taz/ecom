import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { Link, useNavigate } from 'react-router'
import { toast } from '@/lib/toast'
import { z } from 'zod'
import { Field } from '@/components/common/field'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { toUserMessage } from '@/lib/errors'
import { normalizePhone } from '@/lib/phone'
import { supabase } from '@/lib/supabase'

const schema = z.object({
  full_name: z.string().trim().min(2, 'Enter your name'),
  phone: z.string().trim().min(8, 'Enter your mobile number'),
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'Use at least 8 characters'),
})
type Values = z.infer<typeof schema>

export default function RegisterPage() {
  const navigate = useNavigate()
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { full_name: '', phone: '', email: '', password: '' } })
  const signUp = useMutation({
    meta: { silent: true },
    mutationFn: async (v: Values) => {
      const { data, error } = await supabase.auth.signUp({
        email: v.email.trim(),
        password: v.password,
        options: { data: { full_name: v.full_name, phone: normalizePhone(v.phone) }, emailRedirectTo: `${window.location.origin}/account` },
      })
      if (error) throw error
      return data
    },
    onSuccess: (data) => {
      if (data.session) navigate('/account')
      else toast.success('Check your email to confirm your account.')
    },
  })
  const e = form.formState.errors
  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <Card>
        <CardHeader><CardTitle>Create account</CardTitle><CardDescription>Save your details and see all your orders.</CardDescription></CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={form.handleSubmit((v) => signUp.mutate(v))} noValidate>
            <Field label="Full name" htmlFor="full_name" error={e.full_name?.message}><Input id="full_name" autoComplete="name" {...form.register('full_name')} /></Field>
            <Field label="Mobile number" htmlFor="phone" error={e.phone?.message}><Input id="phone" type="tel" autoComplete="tel" {...form.register('phone')} /></Field>
            <Field label="Email" htmlFor="email" error={e.email?.message}><Input id="email" type="email" autoComplete="email" {...form.register('email')} /></Field>
            <Field label="Password" htmlFor="password" error={e.password?.message}><Input id="password" type="password" autoComplete="new-password" {...form.register('password')} /></Field>
            {signUp.error && <p className="text-sm text-destructive">{toUserMessage(signUp.error)}</p>}
            <Button type="submit" disabled={signUp.isPending}>{signUp.isPending && <Spinner />} Create account</Button>
            <p className="text-center text-sm">Already have an account? <Link to="/login" className="underline">Sign in</Link></p>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
