/**
 * verify-pin — secure employee portal authentication
 *
 * POST body: { org_slug, phone, pin }
 *   OR for first-time PIN setup:
 *        { org_slug, phone, new_pin }
 *
 * Returns: { token, employee } on success
 *          { needs_pin_setup } if employee exists but has no PIN yet
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const JWT_SECRET        = Deno.env.get('JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function normalizePhone(phone: string): string {
  return (phone || '').replace(/\D/g, '').slice(-10)
}

async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(String(pin))
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function buildJWT(payload: Record<string, unknown>): Promise<string> {
  const enc = new TextEncoder()
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const body = btoa(JSON.stringify(payload))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const data = `${header}.${body}`
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  const sigStr = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${data}.${sigStr}`
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { org_slug, phone, pin, new_pin } = await req.json()
    if (!org_slug || !phone) return json({ error: 'Missing fields' }, 400)

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    // Resolve org
    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('id, name, status')
      .eq('slug', org_slug)
      .single()
    if (orgErr || !org) return json({ error: 'Organization not found' }, 404)
    if (org.status !== 'active') return json({ error: 'Organization suspended' }, 403)

    const norm = normalizePhone(phone)
    if (norm.length < 10) return json({ error: 'Invalid phone number' }, 400)

    // Find employee by phone
    const { data: employees } = await supabase
      .from('employees')
      .select('id, name, phone, pin, designation, department, employee_id, profile_image, status, role')
      .eq('organization_id', org.id)
      .eq('status', 'Active')

    const matched = (employees || []).find(e => normalizePhone(e.phone) === norm)
    if (!matched) return json({ error: 'Phone number not recognized' }, 401)

    // ── First-time PIN setup ──
    if (!matched.pin) {
      if (!new_pin) {
        // Let app know to show the PIN-setup screen
        return json({ needs_pin_setup: true, employee_name: matched.name })
      }
      if (new_pin.length < 4 || new_pin.length > 6 || !/^\d+$/.test(new_pin)) {
        return json({ error: 'PIN must be 4–6 digits' }, 400)
      }
      const hashed = await hashPin(new_pin)
      await supabase.from('employees').update({ pin: hashed }).eq('id', matched.id)
      matched.pin = hashed
    } else {
      // ── Normal PIN verification ──
      if (!pin) return json({ error: 'PIN required' }, 400)
      const attempt = await hashPin(pin)
      const isPinHashed = matched.pin.length === 64 && /^[0-9a-f]+$/.test(matched.pin)
      const match = isPinHashed ? attempt === matched.pin : pin === matched.pin
      // Upgrade legacy plain-text PIN silently
      if (match && !isPinHashed) {
        await supabase.from('employees').update({ pin: attempt }).eq('id', matched.id)
      }
      if (!match) return json({ error: 'Incorrect PIN' }, 401)
    }

    // Issue custom JWT (Supabase accepts these via its JWT secret)
    const now = Math.floor(Date.now() / 1000)
    const token = await buildJWT({
      sub:         matched.id,
      role:        'authenticated',
      org_id:      org.id,
      employee_id: matched.id,
      iss:         'supabase',
      iat:         now,
      exp:         now + 86400, // 24 h
    })

    const { pin: _p, ...safeEmployee } = matched
    return json({ token, employee: { ...safeEmployee, org_name: org.name, org_id: org.id } })

  } catch (err) {
    console.error('verify-pin error:', err)
    return json({ error: 'Authentication failed' }, 500)
  }
})
