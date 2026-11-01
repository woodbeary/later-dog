import { describe, expect, it } from "vitest";
import { RunSecureForms } from "./computer-use-secure-form.ts";

const SIGN_IN = {
  title: "Sign in to the clinic portal", host: "portal.clinic.example",
  fields: [{ id: "email", label: "Email", type: "email" as const }, { id: "password", label: "Password", type: "password" as const }],
};
const VALUES = { email: "jacob@example.com", password: "fixture-secret-123" };

describe("a run's own Secure Form", () => {
  it("opens a form, takes the person's values once, and hands each value out for typing only", () => {
    const forms = new RunSecureForms();
    const { formId } = forms.open(SIGN_IN);
    expect(formId).toMatch(/^form_[a-f0-9]{16}$/);
    expect(forms.waiting()).toEqual({ formId, title: SIGN_IN.title, host: SIGN_IN.host, status: "open", fields: [
      { id: "email", label: "Email", type: "email" }, { id: "password", label: "Password", type: "password" }] });
    expect(forms.field(formId, "email")).toEqual({ ok: false, text: "The person has not filled in this form yet." });
    expect(forms.submit(formId, { email: "jacob@example.com" })).toEqual({ ok: false, status: 400, error: "Fill in every field." });
    expect(forms.submit(formId, VALUES)).toEqual({ ok: true });
    expect(forms.submit(formId, VALUES)).toMatchObject({ ok: false, status: 409 });
    expect(JSON.stringify(forms.view(formId))).not.toContain(VALUES.password);
    expect(forms.field(formId, "password")).toEqual({ ok: true, host: SIGN_IN.host, label: "Password", value: VALUES.password });
    expect(forms.typed(formId, "email")).toEqual({ last: false });
    expect(forms.typed(formId, "password")).toEqual({ last: true });
    expect(forms.view(formId)!.status).toBe("typed");
  });

  it("types a field at most three times", () => {
    const forms = new RunSecureForms();
    const { formId } = forms.open(SIGN_IN);
    forms.submit(formId, VALUES);
    for (let typing = 0; typing < 3; typing++) forms.typed(formId, "email");
    expect(forms.field(formId, "email")).toMatchObject({ ok: false, text: "Email was already typed 3 times. If it is still needed, ask again with request_secure_form." });
  });

  it("lets a newer form replace an older one, lets the person close one, and wipes every value when the run ends", () => {
    const forms = new RunSecureForms();
    const first = forms.open(SIGN_IN).formId;
    const second = forms.open(SIGN_IN).formId;
    expect(forms.view(first)!.status).toBe("superseded");
    expect(forms.submit(first, VALUES)).toMatchObject({ ok: false, status: 409, error: "A newer form replaced this one." });
    expect(forms.cancel(second)).toBe(true);
    expect(forms.field(second, "email")).toMatchObject({ ok: false, text: "The person closed this form without filling it in." });
    const third = forms.open(SIGN_IN).formId;
    forms.submit(third, VALUES);
    expect(forms.held(third)).toBe(true);
    forms.end();
    expect(forms.held(third)).toBe(false);
    expect(forms.view(third)!.status).toBe("expired");
    expect(forms.field(third, "email")).toMatchObject({ ok: false });
  });
});
