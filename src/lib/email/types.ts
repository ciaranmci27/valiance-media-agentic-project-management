export interface SmtpAccount {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  encrypted_password: string;
  from_name: string;
  from_email: string;
  reply_to: string;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SmtpAccountSafe {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  has_password: boolean;
  from_name: string;
  from_email: string;
  reply_to: string;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
