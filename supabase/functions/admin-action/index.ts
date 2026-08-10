import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPER_ADMIN_SECRET = Deno.env.get('SUPER_ADMIN_SECRET') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const json = await req.json().catch(() => ({}))
  const { secret, action, org_id, message, title, notice_type } = json

  if (!SUPER_ADMIN_SECRET || secret !== SUPER_ADMIN_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  try {
    if (action === 'list_orgs') {
      const { data: orgs, error } = await sb
        .from('organizations')
        .select('id, name, slug, plan, status, max_employees, created_at')
        .order('created_at', { ascending: false })
      if (error) throw error

      // Get employee counts per org
      const { data: empRows } = await sb
        .from('employees')
        .select('organization_id')
        .eq('status', 'Active')
      const counts: Record<string, number> = {}
      ;(empRows || []).forEach((r: any) => { counts[r.organization_id] = (counts[r.organization_id] || 0) + 1 })

      // Get last login per org (last created employee JWT — approximation)
      return new Response(JSON.stringify({
        orgs: (orgs || []).map(o => ({ ...o, active_employees: counts[o.id] || 0 }))
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (action === 'send_notice') {
      if (!org_id || !message) throw new Error('org_id and message are required')
      const { error } = await sb.from('announcements').insert({
        organization_id: org_id,
        title: title || 'Notice from DeepMgmt',
        body: message,
        type: notice_type || 'urgent',
      })
      if (error) throw error
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (action === 'broadcast_notice') {
      // Send to ALL organizations
      if (!message) throw new Error('message is required')
      const { data: orgs } = await sb.from('organizations').select('id')
      const rows = (orgs || []).map((o: any) => ({
        organization_id: o.id,
        title: title || 'Notice from DeepMgmt',
        body: message,
        type: notice_type || 'urgent',
      }))
      if (rows.length) {
        const { error } = await sb.from('announcements').insert(rows)
        if (error) throw error
      }
      return new Response(JSON.stringify({ success: true, orgs_notified: rows.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (action === 'suspend_org') {
      if (!org_id) throw new Error('org_id is required')
      const { error } = await sb.from('organizations').update({ status: 'suspended' }).eq('id', org_id)
      if (error) throw error
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (action === 'restore_org') {
      if (!org_id) throw new Error('org_id is required')
      const { error } = await sb.from('organizations').update({ status: 'active' }).eq('id', org_id)
      if (error) throw error
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Error'
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
