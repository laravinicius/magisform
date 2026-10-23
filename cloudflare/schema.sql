-- Schema do piloto multi-tenant em D1. Aplicação explícita: wrangler d1 execute.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  brand TEXT NOT NULL,
  brand_theme TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS identities (
  id INTEGER PRIMARY KEY,
  access_issuer TEXT NOT NULL,
  access_subject TEXT NOT NULL,
  current_email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (access_issuer, access_subject)
);

CREATE TABLE IF NOT EXISTS platform_admins (
  identity_id INTEGER PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS platform_admin_invites (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
  accepted_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_sessions (
  id INTEGER PRIMARY KEY, identity_id INTEGER NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_action_logs (
  id INTEGER PRIMARY KEY, identity_id INTEGER, actor_email TEXT NOT NULL, actor_name TEXT NOT NULL,
  action TEXT NOT NULL, tenant_id INTEGER, details TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  identity_id INTEGER,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin','manager','pharmacist','employee')),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,username),
  UNIQUE (tenant_id,email),
  UNIQUE (tenant_id,identity_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS preserve_last_active_tenant_admin
BEFORE UPDATE OF role,active ON users
WHEN OLD.active=1 AND OLD.role='admin'
 AND (NEW.active<>1 OR NEW.role<>'admin')
 AND NOT EXISTS (
   SELECT 1 FROM users other
   WHERE other.tenant_id=OLD.tenant_id AND other.id<>OLD.id
     AND other.active=1 AND other.role='admin'
 )
BEGIN
  SELECT RAISE(ABORT,'cannot deactivate or demote the last active tenant administrator');
END;

CREATE TABLE IF NOT EXISTS invitations (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id,user_id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  UNIQUE (tenant_id,user_id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT,
  responsible_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,phone),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,responsible_id) REFERENCES customers(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS insumos (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,name), FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS formulas (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, customer_phone TEXT NOT NULL DEFAULT '',
  attendant_name TEXT NOT NULL DEFAULT '', created_by_user_id INTEGER, created_by_name TEXT, budget_number TEXT NOT NULL DEFAULT '',
  delivery_date TEXT, delivered_at TEXT, payment_status TEXT NOT NULL DEFAULT '', partial_payment_amount REAL,
  payment_method TEXT, delivery_status TEXT NOT NULL DEFAULT '', manager_verified INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','delivered')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id,id), FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,created_by_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS formula_items (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, formula_id INTEGER NOT NULL, insumo_id INTEGER NOT NULL,
  quantity REAL NOT NULL, unit TEXT NOT NULL DEFAULT 'mg', UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,formula_id) REFERENCES formulas(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,insumo_id) REFERENCES insumos(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS formula_budget_items (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, formula_id INTEGER NOT NULL, quantity REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'caps', value REAL NOT NULL DEFAULT 0, is_selected INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tenant_id,id), FOREIGN KEY (tenant_id,formula_id) REFERENCES formulas(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS saved_formulas (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, name TEXT NOT NULL, created_by_user_id INTEGER, created_by_name TEXT, budget_number TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,name), FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,created_by_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS saved_formula_items (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, saved_formula_id INTEGER NOT NULL, insumo_id INTEGER NOT NULL,
  quantity REAL NOT NULL, unit TEXT NOT NULL DEFAULT 'mg', UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,saved_formula_id) REFERENCES saved_formulas(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,insumo_id) REFERENCES insumos(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS saved_formula_budget_items (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, saved_formula_id INTEGER NOT NULL, quantity REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'caps', value REAL NOT NULL DEFAULT 0, is_selected INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tenant_id,id), FOREIGN KEY (tenant_id,saved_formula_id) REFERENCES saved_formulas(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS budget_number_registry (
  tenant_id INTEGER NOT NULL, budget_number TEXT NOT NULL, source_type TEXT NOT NULL CHECK (source_type IN ('formula','saved_formula')),
  source_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id,budget_number), UNIQUE (tenant_id,source_type,source_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS action_logs (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER, user_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER, details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- user_id é um snapshot opcional; FK composta com SET NULL apagaria tenant_id.
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_formulas_tenant_created ON formulas(tenant_id,created_at,id);
CREATE INDEX IF NOT EXISTS idx_logs_tenant_created ON action_logs(tenant_id,created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invitations(tenant_id,email,expires_at);
CREATE INDEX IF NOT EXISTS idx_platform_sessions_expiry ON platform_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_platform_logs_created ON platform_action_logs(created_at);
