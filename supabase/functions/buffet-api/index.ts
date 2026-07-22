import { createClient } from "jsr:@supabase/supabase-js@2";

const SITE_PASSWORD = Deno.env.get("SITE_PASSWORD") ?? "";
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";
const PHOTO_UPLOAD_URL = Deno.env.get("PHOTO_UPLOAD_URL") ?? "";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

// Crude throttle against scripted password guessing.
async function fail(status: number, error: string) {
  if (status === 401 || status === 403) {
    await new Promise((r) => setTimeout(r, 400));
  }
  return new Response(JSON.stringify({ error }), { status, headers: jsonHeaders });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return fail(405, "method_not_allowed");

  const body = await req.json().catch(() => null);
  if (!body || typeof body.action !== "string") return fail(400, "bad_json");

  switch (body.action) {
    case "list": {
      if (body.password !== SITE_PASSWORD) return fail(401, "invalid_password");
      const { data, error } = await db.from("buffet").select("slot_id,category,dish,note");
      if (error) return fail(500, "db_error");
      return ok({ entries: data, photo_upload_url: PHOTO_UPLOAD_URL || null });
    }

    case "claim": {
      if (body.password !== SITE_PASSWORD) return fail(401, "invalid_password");
      const { slot_id, category, name, dish, note, owner_token } = body;
      if (
        typeof slot_id !== "string" || !slot_id ||
        typeof name !== "string" || !name.trim() ||
        typeof owner_token !== "string" || !owner_token
      ) {
        return fail(400, "missing_fields");
      }
      const rec = {
        slot_id,
        category: typeof category === "string" ? category : null,
        name: name.trim(),
        dish: typeof dish === "string" ? dish.trim() : "",
        note: typeof note === "string" ? note.trim() : "",
        owner_token,
      };
      const { error } = await db.from("buffet").insert(rec);
      if (error) {
        if (error.code === "23505") return fail(409, "slot_taken");
        return fail(500, "db_error");
      }
      return ok({ ok: true });
    }

    case "free": {
      if (body.password !== SITE_PASSWORD) return fail(401, "invalid_password");
      const { slot_id, owner_token, admin_password } = body;
      if (typeof slot_id !== "string" || !slot_id) return fail(400, "missing_fields");

      const isAdmin = !!ADMIN_PASSWORD && admin_password === ADMIN_PASSWORD;
      if (!isAdmin) {
        const { data: existing, error: readErr } = await db
          .from("buffet")
          .select("owner_token")
          .eq("slot_id", slot_id)
          .maybeSingle();
        if (readErr) return fail(500, "db_error");
        if (existing && existing.owner_token !== owner_token) {
          return fail(403, "not_owner");
        }
      }
      const { error } = await db.from("buffet").delete().eq("slot_id", slot_id);
      if (error) return fail(500, "db_error");
      return ok({ ok: true });
    }

    case "admin_list": {
      if (!ADMIN_PASSWORD || body.admin_password !== ADMIN_PASSWORD) {
        return fail(401, "invalid_password");
      }
      const { data, error } = await db
        .from("buffet")
        .select("slot_id,category,name,dish,note,created_at")
        .order("category")
        .order("slot_id");
      if (error) return fail(500, "db_error");
      return ok({ entries: data });
    }

    default:
      return fail(400, "unknown_action");
  }
});
