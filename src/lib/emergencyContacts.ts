// ---------------------------------------------------------------------------
// EMERGENCY CONTACTS — read and maintained in the database (migration 0044). Nothing is
// hard-coded in the app. Who may add or edit is decided by the database (company administrator
// anywhere in their company; assigned site manager / safety officer for their own site); a
// hidden form is a courtesy, a refused call is the control.
// ---------------------------------------------------------------------------
import { supabase } from "./supabase";

export interface EmergencyContact {
  id: string;
  organization_id: string;
  site_id: string | null;
  name: string;
  phone: string;
  role_label: string | null;
  sort_order: number;
  active: boolean;
}
export interface ContactScope { organization_id: string; organization_name: string; site_id: string | null; site_name: string | null }

export const PHONE_PATTERN = /^[+]?[0-9 ()-]{3,24}$/;

export async function listEmergencyContacts(): Promise<EmergencyContact[]> {
  const { data, error } = await supabase.from("emergency_contacts").select("*").order("sort_order", { ascending: true }).order("name", { ascending: true }).limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as EmergencyContact[];
}
export async function contactScopes(): Promise<ContactScope[]> {
  const { data, error } = await supabase.rpc("mg_emergency_contact_scopes");
  if (error) throw new Error(error.message);
  return (data ?? []) as ContactScope[];
}
export interface ContactInput { organizationId: string; siteId: string | null; name: string; phone: string; roleLabel?: string; sortOrder?: number; active?: boolean }
export async function saveEmergencyContact(i: ContactInput, id?: string): Promise<string> {
  const { data, error } = await supabase.rpc("mg_emergency_contact_save", {
    p_org: i.organizationId, p_site: i.siteId, p_name: i.name, p_phone: i.phone,
    p_role_label: i.roleLabel || null, p_sort: i.sortOrder ?? 100, p_active: i.active ?? true, p_id: id ?? null,
  });
  if (error) throw new Error(error.message);
  return data as string;
}
export async function removeEmergencyContact(id: string): Promise<void> {
  const { error } = await supabase.rpc("mg_emergency_contact_remove", { p_id: id });
  if (error) throw new Error(error.message);
}
export function explainContactError(e: unknown): string {
  const m = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
  if (/FORBIDDEN/i.test(m)) return "You are not allowed to change emergency contacts here.";
  if (/emergency_contacts_phone_check|phone/i.test(m)) return "Enter a valid phone number (digits, spaces, + ( ) -).";
  if (/emergency_contacts_name_check/i.test(m)) return "Enter a name (up to 80 characters).";
  return "That could not be saved. Nothing was changed; try again.";
}
