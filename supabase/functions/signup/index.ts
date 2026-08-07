import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? ''
const RESEND_FROM = Deno.env.get('RESEND_FROM') ?? 'DeepMgmt <hello@deepmgmt.app>'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

async function sendWelcomeEmail(email: string, orgName: string, slug: string) {
  if (!RESEND_API_KEY) return
  const appUrl = `https://ohmdeepcerts.github.io/DeepMgmt`
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: email,
      subject: `Welcome to DeepMgmt — ${orgName} is ready!`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px">
          <h2 style="color:#1a1a2e">Your workspace is live 🎉</h2>
          <p>Hi there,</p>
          <p><strong>${orgName}</strong> is set up and ready to use.</p>
          <p style="margin:24px 0">
            <a href="${appUrl}/app/?org=${slug}" style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
              Open Office App →
            </a>
          </p>
          <p style="color:#666;font-size:14px">Share the employee portal with your team:<br>
            <code>${appUrl}/employee/?org=${slug}</code>
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
          <p style="color:#999;font-size:12px">DeepMgmt — HR & Payroll for growing teams</p>
        </div>
      `,
    }),
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { org_name, admin_email, admin_password, company_size } = await req.json()

    if (!org_name || !admin_email || !admin_password) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (admin_password.length < 8) {
      return new Response(JSON.stringify({ error: 'Password must be at least 8 characters' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    // Generate unique slug
    let slug = slugify(org_name)
    const { data: existing } = await supabase.from('organizations').select('slug').eq('slug', slug)
    if (existing && existing.length > 0) slug = `${slug}-${Date.now().toString(36)}`

    // Create auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: admin_email,
      password: admin_password,
      email_confirm: true,
    })
    if (authError) throw authError

    const userId = authData.user.id
    const maxEmployees = company_size === 'small' ? 25 : company_size === 'medium' ? 100 : 500

    // Create organization
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .insert({ name: org_name, slug, max_employees: maxEmployees })
      .select()
      .single()
    if (orgError) {
      await supabase.auth.admin.deleteUser(userId)
      throw orgError
    }

    // Link user to org
    const { error: ouError } = await supabase
      .from('org_users')
      .insert({ organization_id: org.id, user_id: userId, role: 'admin' })
    if (ouError) {
      await supabase.auth.admin.deleteUser(userId)
      throw ouError
    }

    // Send welcome email (non-blocking)
    sendWelcomeEmail(admin_email, org_name, slug).catch(console.error)

    return new Response(
      JSON.stringify({
        success: true,
        org_id: org.id,
        org_slug: slug,
        app_url: `https://ohmdeepcerts.github.io/DeepMgmt/app/?org=${slug}`,
        employee_url: `https://ohmdeepcerts.github.io/DeepMgmt/employee/?org=${slug}`,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('signup error', err)
    const msg = err instanceof Error ? err.message : 'Signup failed'
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
