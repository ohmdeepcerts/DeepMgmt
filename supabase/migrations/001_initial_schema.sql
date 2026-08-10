-- ============================================================
-- DeepMgmt SaaS — Initial Schema
-- Run this once in a fresh Supabase project (SQL Editor)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. ORGANIZATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS organizations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  plan            TEXT NOT NULL DEFAULT 'trial',
  status          TEXT NOT NULL DEFAULT 'active',
  max_employees   INT NOT NULL DEFAULT 25,
  r2_bucket_url   TEXT,
  resend_from     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  trial_ends_at   TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days')
);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. ORG_USERS  (admin/office users)
-- ============================================================
CREATE TABLE IF NOT EXISTS org_users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'admin',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

ALTER TABLE org_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_users_own" ON org_users
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- Helper: resolve org_id for the current JWT
--   • Admin sessions  → looks up org_users table by auth.uid()
--   • Employee portal → reads 'org_id' JWT claim
-- ============================================================
CREATE OR REPLACE FUNCTION current_org_id()
RETURNS UUID LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(
    (SELECT organization_id FROM org_users WHERE user_id = auth.uid() LIMIT 1),
    (auth.jwt() ->> 'org_id')::uuid
  );
$$;

-- Org admins can see/update their own org row
CREATE POLICY "org_members_own_org" ON organizations
  FOR ALL TO authenticated
  USING  (id = current_org_id())
  WITH CHECK (id = current_org_id());

-- ============================================================
-- Auto-set organization_id trigger (applied to all data tables)
-- Prevents the apps from having to include organization_id in
-- every INSERT — the trigger reads it from the current session.
-- ============================================================
CREATE OR REPLACE FUNCTION auto_set_org_id()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := current_org_id();
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- 3. SETTINGS  (one row per org; same id=1 pattern as original)
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  id              INT  NOT NULL DEFAULT 1 CHECK (id = 1),
  -- core settings
  currency        TEXT    DEFAULT '£',
  company_name    TEXT,
  work_start      TEXT    DEFAULT '09:00',
  work_end        TEXT    DEFAULT '17:00',
  ot_threshold    NUMERIC DEFAULT 8,
  rate_ot         NUMERIC DEFAULT 1.5,
  rate_sat        NUMERIC DEFAULT 1.0,
  rate_sun        NUMERIC DEFAULT 1.0,
  threshold       INT     DEFAULT 80,
  -- API keys (stored per-org, NOT in source code)
  gemini_key      TEXT    DEFAULT '',
  resend_key      TEXT    DEFAULT '',
  r2_url          TEXT    DEFAULT '',
  -- structured data
  locked_months   JSONB   DEFAULT '[]',
  categories      JSONB   DEFAULT '[]',
  tags            JSONB   DEFAULT '[]',
  material_groups         JSONB DEFAULT '{}',
  material_processed_ids  JSONB DEFAULT '[]',
  PRIMARY KEY (organization_id, id)
);

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settings_by_org" ON settings
  FOR ALL TO authenticated
  USING  (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER settings_auto_org BEFORE INSERT ON settings
  FOR EACH ROW EXECUTE FUNCTION auto_set_org_id();

-- ============================================================
-- 4. EMPLOYEES
-- ============================================================
CREATE TABLE IF NOT EXISTS employees (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  employee_id     TEXT,
  designation     TEXT,
  department      TEXT,
  phone           TEXT,
  email           TEXT,
  salary          NUMERIC(12,2),
  join_date       DATE,
  status          TEXT DEFAULT 'Active',
  pin             TEXT,
  pin_salt        TEXT,
  advance         NUMERIC(12,2) DEFAULT 0,
  profile_image   TEXT,
  work_start      TEXT,
  work_end        TEXT,
  ot_threshold    NUMERIC,
  sat_mult        NUMERIC,
  sun_mult        NUMERIC,
  role            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY "employees_by_org" ON employees
  FOR ALL TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      (auth.jwt() ->> 'employee_id') IS NULL
      OR id = (auth.jwt() ->> 'employee_id')::uuid
    )
  )
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER employees_auto_org BEFORE INSERT ON employees
  FOR EACH ROW EXECUTE FUNCTION auto_set_org_id();

-- ============================================================
-- 5. ATTENDANCE
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  status          TEXT NOT NULL,
  notes           TEXT,
  sign_in         TEXT,
  sign_out        TEXT,
  hours           NUMERIC(5,2),
  overtime        NUMERIC(5,2),
  bonus           NUMERIC(12,2) DEFAULT 0,
  jobs            INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "attendance_by_org" ON attendance
  FOR ALL TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      (auth.jwt() ->> 'employee_id') IS NULL
      OR employee_id = (auth.jwt() ->> 'employee_id')::uuid
    )
  )
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER attendance_auto_org BEFORE INSERT ON attendance
  FOR EACH ROW EXECUTE FUNCTION auto_set_org_id();

-- ============================================================
-- 6. EXPENSES
-- ============================================================
CREATE TABLE IF NOT EXISTS expenses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  batch_id        UUID,
  date            DATE NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  category        TEXT,
  description     TEXT,
  merchant        TEXT,
  receipt_url     TEXT,
  notes           TEXT,
  items           TEXT,
  status          TEXT DEFAULT 'pending',
  flagged         BOOLEAN DEFAULT FALSE,
  tags            JSONB DEFAULT '[]',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "expenses_by_org" ON expenses
  FOR ALL TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      (auth.jwt() ->> 'employee_id') IS NULL
      OR employee_id = (auth.jwt() ->> 'employee_id')::uuid
    )
  )
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER expenses_auto_org BEFORE INSERT ON expenses
  FOR EACH ROW EXECUTE FUNCTION auto_set_org_id();

-- ============================================================
-- 7. EXPENSE_BATCHES
-- ============================================================
CREATE TABLE IF NOT EXISTS expense_batches (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  submitted_at    TIMESTAMPTZ DEFAULT NOW(),
  status          TEXT DEFAULT 'pending',
  total_amount    NUMERIC(12,2),
  notes           TEXT,
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     TEXT
);

ALTER TABLE expense_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "expense_batches_by_org" ON expense_batches
  FOR ALL TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      (auth.jwt() ->> 'employee_id') IS NULL
      OR employee_id = (auth.jwt() ->> 'employee_id')::uuid
    )
  )
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER expense_batches_auto_org BEFORE INSERT ON expense_batches
  FOR EACH ROW EXECUTE FUNCTION auto_set_org_id();

-- ============================================================
-- 8. MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  sender          TEXT NOT NULL DEFAULT 'office',  -- 'office' | 'employee'
  read            BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "messages_by_org" ON messages
  FOR ALL TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      (auth.jwt() ->> 'employee_id') IS NULL
      OR employee_id = (auth.jwt() ->> 'employee_id')::uuid
    )
  )
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER messages_auto_org BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION auto_set_org_id();

-- ============================================================
-- 9. ANNOUNCEMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS announcements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  type            TEXT DEFAULT 'info',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ
);

ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "announcements_by_org" ON announcements
  FOR ALL TO authenticated
  USING  (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER announcements_auto_org BEFORE INSERT ON announcements
  FOR EACH ROW EXECUTE FUNCTION auto_set_org_id();

-- ============================================================
-- 10. MERCHANT_CATEGORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS merchant_categories (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  keywords        TEXT[],
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE merchant_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "merchant_categories_by_org" ON merchant_categories
  FOR ALL TO authenticated
  USING  (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER merchant_categories_auto_org BEFORE INSERT ON merchant_categories
  FOR EACH ROW EXECUTE FUNCTION auto_set_org_id();

-- ============================================================
-- 11. EMPLOYEE_DOCUMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS employee_documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  type            TEXT,
  url             TEXT,
  size            BIGINT,
  uploaded_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE employee_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "employee_documents_by_org" ON employee_documents
  FOR ALL TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      (auth.jwt() ->> 'employee_id') IS NULL
      OR employee_id = (auth.jwt() ->> 'employee_id')::uuid
    )
  )
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER employee_documents_auto_org BEFORE INSERT ON employee_documents
  FOR EACH ROW EXECUTE FUNCTION auto_set_org_id();

-- ============================================================
-- 12. SALARY_HISTORY
-- ============================================================
CREATE TABLE IF NOT EXISTS salary_history (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id       UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month             TEXT NOT NULL,
  effective_from    DATE,
  base_salary       NUMERIC(12,2),
  gross_salary      NUMERIC(12,2),
  deductions        NUMERIC(12,2) DEFAULT 0,
  net_salary        NUMERIC(12,2),
  advance_deducted  NUMERIC(12,2) DEFAULT 0,
  status            TEXT DEFAULT 'pending',
  paid_at           TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE salary_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "salary_history_by_org" ON salary_history
  FOR ALL TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      (auth.jwt() ->> 'employee_id') IS NULL
      OR employee_id = (auth.jwt() ->> 'employee_id')::uuid
    )
  )
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER salary_history_auto_org BEFORE INSERT ON salary_history
  FOR EACH ROW EXECUTE FUNCTION auto_set_org_id();

-- ============================================================
-- 13. PAYMENT_STATUS
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_status (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month           TEXT NOT NULL,
  status          TEXT DEFAULT 'pending',
  amount          NUMERIC(12,2),
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (organization_id, employee_id, month)
);

ALTER TABLE payment_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payment_status_by_org" ON payment_status
  FOR ALL TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      (auth.jwt() ->> 'employee_id') IS NULL
      OR employee_id = (auth.jwt() ->> 'employee_id')::uuid
    )
  )
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER payment_status_auto_org BEFORE INSERT ON payment_status
  FOR EACH ROW EXECUTE FUNCTION auto_set_org_id();

-- ============================================================
-- 14. ATTENDANCE_REQUESTS
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance_requests (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id      UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  type             TEXT NOT NULL,
  sign_in          TEXT,
  sign_out         TEXT,
  hours            NUMERIC(5,2),
  employee_note    TEXT,
  office_note      TEXT,
  status           TEXT DEFAULT 'pending',
  reviewed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE attendance_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "attendance_requests_by_org" ON attendance_requests
  FOR ALL TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      (auth.jwt() ->> 'employee_id') IS NULL
      OR employee_id = (auth.jwt() ->> 'employee_id')::uuid
    )
  )
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER attendance_requests_auto_org BEFORE INSERT ON attendance_requests
  FOR EACH ROW EXECUTE FUNCTION auto_set_org_id();

-- ============================================================
-- 15. PAYROLL_SUMMARY
-- ============================================================
CREATE TABLE IF NOT EXISTS payroll_summary (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id        UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month              TEXT NOT NULL,
  year               INT,
  total_days         INT,
  present_days       INT,
  absent_days        INT,
  half_days          INT,
  effective_days     NUMERIC(5,2),
  earned_salary      NUMERIC(12,2),
  expense_total      NUMERIC(12,2) DEFAULT 0,
  advance_deduction  NUMERIC(12,2) DEFAULT 0,
  net_payable        NUMERIC(12,2),
  locked             BOOLEAN DEFAULT FALSE,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (organization_id, employee_id, month)
);

ALTER TABLE payroll_summary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payroll_summary_by_org" ON payroll_summary
  FOR ALL TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      (auth.jwt() ->> 'employee_id') IS NULL
      OR employee_id = (auth.jwt() ->> 'employee_id')::uuid
    )
  )
  WITH CHECK (organization_id = current_org_id());

CREATE TRIGGER payroll_summary_auto_org BEFORE INSERT ON payroll_summary
  FOR EACH ROW EXECUTE FUNCTION auto_set_org_id();

-- ============================================================
-- Indexes for common query patterns
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_employees_org      ON employees    (organization_id);
CREATE INDEX IF NOT EXISTS idx_attendance_emp_dt  ON attendance   (employee_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_org_dt  ON attendance   (organization_id, date);
CREATE INDEX IF NOT EXISTS idx_expenses_emp_dt    ON expenses     (employee_id, date);
CREATE INDEX IF NOT EXISTS idx_expenses_org       ON expenses     (organization_id);
CREATE INDEX IF NOT EXISTS idx_messages_emp_ts    ON messages     (employee_id, created_at);
CREATE INDEX IF NOT EXISTS idx_salary_hist_emp    ON salary_history (employee_id, month);
CREATE INDEX IF NOT EXISTS idx_payroll_org_mo     ON payroll_summary (organization_id, month);
CREATE INDEX IF NOT EXISTS idx_att_req_emp_dt     ON attendance_requests (employee_id, date);
CREATE INDEX IF NOT EXISTS idx_org_slug           ON organizations (slug);
