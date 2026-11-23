-- Farmácias solicitantes e pedidos ficam separados dos registros legados.
CREATE TABLE IF NOT EXISTS partner_pharmacies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS partner_memberships (
  user_id INT NOT NULL PRIMARY KEY,
  pharmacy_id INT NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_partner_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_partner_member_pharmacy FOREIGN KEY (pharmacy_id) REFERENCES partner_pharmacies(id) ON DELETE RESTRICT,
  KEY idx_partner_member_pharmacy (pharmacy_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS partner_patients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pharmacy_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(30) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_partner_patient_pharmacy FOREIGN KEY (pharmacy_id) REFERENCES partner_pharmacies(id) ON DELETE RESTRICT,
  UNIQUE KEY uq_partner_patient (pharmacy_id, name, phone)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pharmacy_id INT NOT NULL,
  legacy_formula_id INT NULL,
  status ENUM('submitted','under_review','awaiting_approval','accepted') NOT NULL DEFAULT 'submitted',
  original_data LONGTEXT NOT NULL CHECK (JSON_VALID(original_data)),
  current_data LONGTEXT NOT NULL CHECK (JSON_VALID(current_data)),
  proposed_data LONGTEXT NULL CHECK (proposed_data IS NULL OR JSON_VALID(proposed_data)),
  revision INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_pharmacy FOREIGN KEY (pharmacy_id) REFERENCES partner_pharmacies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_legacy_formula FOREIGN KEY (legacy_formula_id) REFERENCES formulas(id) ON DELETE RESTRICT,
  UNIQUE KEY uq_order_legacy_formula (legacy_formula_id),
  KEY idx_order_pharmacy_created (pharmacy_id, created_at, id),
  KEY idx_order_status_created (status, created_at, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  user_id INT NULL,
  actor_name VARCHAR(255) NOT NULL,
  action ENUM('submitted','imported','reviewed','accepted','proposed','approved','rejected') NOT NULL,
  snapshot LONGTEXT NULL CHECK (snapshot IS NULL OR JSON_VALID(snapshot)),
  note TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_event_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_event_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  KEY idx_order_event_order (order_id, id)
) ENGINE=InnoDB;

