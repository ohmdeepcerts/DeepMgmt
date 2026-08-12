import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPER_ADMIN_SECRET = Deno.env.get('SUPER_ADMIN_SECRET') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PLAN_CONFIG: Record<string, { price: number; maxEmps: number }> = {
  trial:      { price: 0,   maxEmps: 25   },
  free:       { price: 0,   maxEmps: 10   },
  starter:    { price: 29,  maxEmps: 50   },
  pro:        { price: 79,  maxEmps: 200  },
  enterprise: { price: 199, maxEmps: 9999 },
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const json = await req.json().catch(() => ({}))
  const { secret, action, org_id, message, title, notice_type, plan } = json

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

      const { data: empRows } = await sb
        .from('employees')
        .select('organization_id')
        .eq('status', 'Active')
      const counts: Record<string, number> = {}
      ;(empRows || []).forEach((r: any) => { counts[r.organization_id] = (counts[r.organization_id] || 0) + 1 })

      // Fetch admin emails: join org_users → auth.users
      const { data: orgUsers } = await sb.from('org_users').select('organization_id, user_id')
      const userIds = [...new Set((orgUsers || []).map((u: any) => u.user_id))]
      const emailMap: Record<string, string> = {}
      if (userIds.length) {
        const { data: { users } } = await sb.auth.admin.listUsers({ perPage: 1000 })
        users.forEach((u: any) => { emailMap[u.id] = u.email || '' })
      }
      const orgEmailMap: Record<string, string> = {}
      ;(orgUsers || []).forEach((u: any) => {
        if (!orgEmailMap[u.organization_id]) orgEmailMap[u.organization_id] = emailMap[u.user_id] || ''
      })

      return new Response(JSON.stringify({
        orgs: (orgs || []).map(o => ({ ...o, active_employees: counts[o.id] || 0, admin_email: orgEmailMap[o.id] || '' }))
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (action === 'get_stats') {
      // Count records per table per org (DB usage proxy)
      const tables = ['employees', 'attendance_logs', 'expenses', 'payslips', 'announcements']
      const stats: Record<string, Record<string, number>> = {}

      for (const table of tables) {
        const { data } = await sb.from(table).select('organization_id')
        ;(data || []).forEach((r: any) => {
          if (!stats[r.organization_id]) stats[r.organization_id] = {}
          stats[r.organization_id][table] = (stats[r.organization_id][table] || 0) + 1
        })
      }

      // Also count documents if table exists
      try {
        const { data: docs } = await sb.from('documents').select('organization_id')
        ;(docs || []).forEach((r: any) => {
          if (!stats[r.organization_id]) stats[r.organization_id] = {}
          stats[r.organization_id]['documents'] = (stats[r.organization_id]['documents'] || 0) + 1
        })
      } catch (_) { /* table may not exist */ }

      return new Response(JSON.stringify({ stats }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (action === 'change_plan') {
      if (!org_id || !plan) throw new Error('org_id and plan are required')
      const cfg = PLAN_CONFIG[plan]
      if (!cfg) throw new Error(`Unknown plan: ${plan}`)
      const { error } = await sb.from('organizations')
        .update({ plan, max_employees: cfg.maxEmps })
        .eq('id', org_id)
      if (error) throw error
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
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

    if (action === 'create_org') {
      const { admin_email, org_name, plan: newPlan } = json
      if (!admin_email || !org_name) throw new Error('admin_email and org_name are required')
      // Find existing auth user by email
      const { data: { users } } = await sb.auth.admin.listUsers({ perPage: 1000 })
      const existingUser = users.find((u: any) => u.email?.toLowerCase() === admin_email.toLowerCase())
      if (!existingUser) throw new Error(`No auth user found for ${admin_email} — they must sign up first`)
      const userId = existingUser.id
      // Generate unique slug
      let slug = org_name.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)
      const { data: existing } = await sb.from('organizations').select('slug').eq('slug', slug)
      if (existing && existing.length > 0) slug = `${slug}-${Date.now().toString(36)}`
      // Create org
      const usedPlan = newPlan || 'trial'
      const cfg: Record<string,{price:number;maxEmps:number}> = {trial:{price:0,maxEmps:25},free:{price:0,maxEmps:10},starter:{price:29,maxEmps:50},pro:{price:79,maxEmps:200},enterprise:{price:199,maxEmps:9999}}
      const maxEmps = cfg[usedPlan]?.maxEmps ?? 25
      const { data: org, error: orgErr } = await sb.from('organizations').insert({ name: org_name, slug, plan: usedPlan, max_employees: maxEmps }).select().single()
      if (orgErr) throw orgErr
      // Link user to org
      const { error: ouErr } = await sb.from('org_users').insert({ organization_id: org.id, user_id: userId, role: 'admin' })
      if (ouErr) { await sb.from('organizations').delete().eq('id', org.id); throw ouErr }
      // Create default settings
      await sb.from('settings').insert({ organization_id: org.id, id: 1, currency: '£' }).then(()=>{})
      return new Response(JSON.stringify({ success: true, org_id: org.id, org_slug: slug, app_url: `https://ohmdeepcerts.github.io/DeepMgmt/app/?org=${slug}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (action === 'delete_org') {
      if (!org_id) throw new Error('org_id is required')
      // Delete child records first to avoid FK violations
      for (const t of ['announcements','payslips','expenses','attendance_logs','employees','org_users']) {
        await sb.from(t).delete().eq('organization_id', org_id)
      }
      // Also try documents table if it exists
      try { await sb.from('documents').delete().eq('organization_id', org_id) } catch (_) {}
      const { error } = await sb.from('organizations').delete().eq('id', org_id)
      if (error) throw error
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : JSON.stringify(err)
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
