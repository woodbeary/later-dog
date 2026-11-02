import { randomUUID } from "node:crypto";
import type { SecureFormField } from "../../shared/secure-form.ts";
import {
  parseSecureValues, SECURE_FIELD_MAX_TYPINGS, SECURE_FORM_AFTER_FILLED_MS, SECURE_FORM_TOOLS, SECURE_FORM_TTL_MS, SecureFormVault,
  type SecureFormDesk, type SecureFormInput,
} from "./secure-form.ts";

export const REQUEST_FORM_TOOL_NAME = "request_secure_form";
export const FILL_FIELD_TOOL_NAME = "fill_secure_field";
export type RunFormStatus = "open" | "filled" | "typed" | "cancelled" | "superseded" | "expired";

export interface RunFormView {
  formId: string;
  title: string;
  host: string;
  fields: Array<Pick<SecureFormField, "id" | "label" | "type" | "autocomplete" | "optional">>;
  status: RunFormStatus;
}

const schemaOf = (name: string) => SECURE_FORM_TOOLS.find((tool) => tool.name === name)!.inputSchema;

export const LOOP_SECURE_FORM_TOOLS = [
  {
    name: REQUEST_FORM_TOOL_NAME,
    description: "Ask the person for details only they know (an email or username, a password, a one-time code) with a sealed Secure Form, to sign in on this desktop. Open the sign-in page first; site is the host shown in the browser's address bar, for example accounts.example.com. Name the step plainly, for example \"Sign in to the clinic portal\". You never see the values. later.dog answers when the person has filled the form in; then type each value with fill_secure_field.",
    input_schema: schemaOf(REQUEST_FORM_TOOL_NAME),
  },
  {
    name: FILL_FIELD_TOOL_NAME,
    description: "Type one value from a filled Secure Form into the field at x, y of the browser page, in screenshot pixels. later.dog checks the browser is on the form's site over HTTPS, clicks the field and types the value; you never see it. Set submit to press Enter afterwards, then take a screenshot to check the page.",
    input_schema: schemaOf(FILL_FIELD_TOOL_NAME),
  },
] as const;

interface RunForm {
  title: string;
  host: string;
  fields: SecureFormField[];
  status: RunFormStatus;
  typed: Map<string, number>;
}

export class RunSecureForms implements SecureFormDesk {
  readonly #forms = new Map<string, RunForm>();
  readonly #vault = new SecureFormVault((formId) => this.#expire(formId));

  open(input: SecureFormInput): { formId: string } {
    for (const [formId, form] of this.#forms) {
      if (form.status === "open" || form.status === "filled") { this.#vault.forget(formId); form.status = "superseded"; }
    }
    const formId = `form_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.#forms.set(formId, { title: input.title, host: input.host, fields: input.fields.map((field) => ({ ...field })), status: "open", typed: new Map() });
    return { formId };
  }

  submit(formId: string, raw: unknown): { ok: true } | { ok: false; status: 400 | 404 | 409; error: string } {
    const form = this.#forms.get(formId);
    if (!form) return { ok: false, status: 404, error: "This run has no Secure Form with that id." };
    if (form.status !== "open") return { ok: false, status: 409, error: form.status === "superseded" ? "A newer form replaced this one." : "This form was already answered." };
    const values = parseSecureValues(form.fields, raw);
    if (!(values instanceof Map)) return { ok: false, status: 400, error: values.error };
    for (const field of form.fields) if (field.optional && !values.has(field.id)) field.filled = true;
    this.#vault.hold(formId, values, SECURE_FORM_TTL_MS);
    form.status = "filled";
    return { ok: true };
  }

  cancel(formId: string): boolean {
    const form = this.#forms.get(formId);
    if (!form || form.status !== "open") return false;
    form.status = "cancelled";
    return true;
  }

  field(formId: string, fieldId: string): ReturnType<SecureFormDesk["field"]> {
    const form = this.#forms.get(formId);
    if (!form) return { ok: false, text: "There is no Secure Form with that form_id in this run. Use the form_id from request_secure_form." };
    if (form.status === "open") return { ok: false, text: "The person has not filled in this form yet." };
    if (form.status === "superseded") return { ok: false, text: "A newer Secure Form replaced this one. Use the newest form_id." };
    if (form.status === "cancelled") return { ok: false, text: "The person closed this form without filling it in." };
    const entry = form.fields.find((candidate) => candidate.id === fieldId);
    if (!entry) return { ok: false, text: `This form has no field ${JSON.stringify(fieldId)}. Its fields are ${form.fields.map((candidate) => candidate.id).join(", ")}.` };
    const value = this.#vault.value(formId, fieldId);
    if (value === undefined && entry.optional && entry.filled && this.#vault.has(formId)) return { ok: false, text: `${entry.label} was left empty, so there is nothing to type: leave that box as it is.` };
    if (value === undefined) return { ok: false, text: "The details from this form were cleared. If they are still needed, ask again with request_secure_form." };
    if ((form.typed.get(fieldId) ?? 0) >= SECURE_FIELD_MAX_TYPINGS) return { ok: false, text: `${entry.label} was already typed ${SECURE_FIELD_MAX_TYPINGS} times. If it is still needed, ask again with request_secure_form.` };
    return { ok: true, host: form.host, label: entry.label, value };
  }

  typed(formId: string, fieldId: string): { last: boolean } {
    const form = this.#forms.get(formId);
    if (!form) return { last: false };
    form.typed.set(fieldId, (form.typed.get(fieldId) ?? 0) + 1);
    const entry = form.fields.find((candidate) => candidate.id === fieldId);
    if (entry) entry.filled = true;
    const last = form.fields.every((candidate) => candidate.filled);
    if (last) { form.status = "typed"; this.#vault.shorten(formId, SECURE_FORM_AFTER_FILLED_MS); }
    return { last };
  }

  view(formId: string): RunFormView | null {
    const form = this.#forms.get(formId);
    if (!form) return null;
    return { formId, title: form.title, host: form.host, status: form.status,
      fields: form.fields.map(({ id, label, type, autocomplete, optional }) => ({ id, label, type, ...(autocomplete ? { autocomplete } : {}), ...(optional ? { optional } : {}) })) };
  }

  waiting(): RunFormView | null {
    for (const formId of this.#forms.keys()) if (this.#forms.get(formId)!.status === "open") return this.view(formId);
    return null;
  }

  held(formId: string): boolean {
    return this.#vault.has(formId);
  }

  end(): void {
    for (const [formId, form] of this.#forms) {
      this.#vault.forget(formId);
      if (form.status === "open" || form.status === "filled") form.status = "expired";
    }
  }

  #expire(formId: string): void {
    const form = this.#forms.get(formId);
    if (form?.status === "filled") form.status = "expired";
  }
}
