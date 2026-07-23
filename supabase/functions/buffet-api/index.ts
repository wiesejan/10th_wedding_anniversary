import { createClient } from "jsr:@supabase/supabase-js@2";
import { XMLParser } from "https://esm.sh/fast-xml-parser@4";

const SITE_PASSWORD = Deno.env.get("SITE_PASSWORD") ?? "";
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";
const PHOTO_UPLOAD_URL = Deno.env.get("PHOTO_UPLOAD_URL") ?? "";
// Optional: separater Lese-Freigabe-Link + Passwort, falls Album-Share vom
// Upload-Share abweicht bzw. passwortgeschützt ist.
const PHOTO_ALBUM_URL = Deno.env.get("PHOTO_ALBUM_URL") ?? "";
const PHOTO_SHARE_PASSWORD = Deno.env.get("PHOTO_SHARE_PASSWORD") ?? "";

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
async function fail(status: number, error: string, extra?: Record<string, unknown>) {
  if (status === 401 || status === 403) {
    await new Promise((r) => setTimeout(r, 400));
  }
  return new Response(
    JSON.stringify({ error, ...(extra ?? {}) }),
    { status, headers: jsonHeaders },
  );
}

// ---------- Foto-Album (Nextcloud Public Share) ----------

// Zerlegt einen Nextcloud-Freigabelink ".../s/<token>" in Basis-URL + Token.
function parseShareUrl(u: string): { base: string; token: string } | null {
  try {
    const url = new URL(u);
    const parts = url.pathname.split("/").filter(Boolean); // ["s", "<token>"]
    const sIdx = parts.indexOf("s");
    const token = sIdx >= 0 ? parts[sIdx + 1] : parts[parts.length - 1];
    if (!token) return null;
    return { base: `${url.protocol}//${url.host}`, token };
  } catch {
    return null;
  }
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop>
<d:getlastmodified/><d:getcontenttype/><d:getcontentlength/><d:resourcetype/>
</d:prop></d:propfind>`;

const xmlParser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });

type Photo = { name: string; thumb: string; full: string; mtime: string };

// Leichter Cache, damit paralleles Laden mehrerer Gäste Nextcloud nicht flutet.
let photoCache: { at: number; data: Photo[] } | null = null;
const PHOTO_CACHE_MS = 30_000;

async function propfind(endpoint: string, token: string): Promise<Response> {
  return await fetch(endpoint, {
    method: "PROPFIND",
    headers: {
      Authorization: "Basic " + btoa(`${token}:${PHOTO_SHARE_PASSWORD}`),
      Depth: "1",
      "Content-Type": "application/xml",
    },
    body: PROPFIND_BODY,
  });
}

async function listPhotos(): Promise<{ photos?: Photo[]; error?: string; status?: number }> {
  if (photoCache && Date.now() - photoCache.at < PHOTO_CACHE_MS) {
    return { photos: photoCache.data };
  }
  const shareUrl = PHOTO_ALBUM_URL || PHOTO_UPLOAD_URL;
  const parsed = parseShareUrl(shareUrl);
  if (!parsed) return { error: "no_share_configured" };
  const { base, token } = parsed;

  // Primärer Endpoint + Fallback für ältere/neuere Nextcloud-Versionen.
  const endpoints = [
    `${base}/public.php/webdav/`,
    `${base}/public.php/dav/files/${token}/`,
  ];
  let res: Response | null = null;
  for (const ep of endpoints) {
    try {
      const r = await propfind(ep, token);
      if (r.ok || r.status === 207) { res = r; break; }
      res = r; // letzten Fehler behalten
    } catch (_e) {
      // nächsten Endpoint versuchen
    }
  }
  if (!res || !(res.ok || res.status === 207)) {
    return { error: "nextcloud_list_failed", status: res?.status ?? 0 };
  }

  const xml = await res.text();
  let parsedXml: any;
  try {
    parsedXml = xmlParser.parse(xml);
  } catch (_e) {
    return { error: "xml_parse_failed" };
  }

  const responses = parsedXml?.multistatus?.response;
  const list = Array.isArray(responses) ? responses : responses ? [responses] : [];

  const photos: Photo[] = [];
  for (const entry of list) {
    const href: string = entry?.href ?? "";
    const propstat = Array.isArray(entry?.propstat) ? entry.propstat[0] : entry?.propstat;
    const prop = propstat?.prop ?? {};
    // Ordner selbst / Unterordner überspringen.
    const isCollection = prop?.resourcetype && typeof prop.resourcetype === "object" &&
      "collection" in prop.resourcetype;
    if (isCollection || href.endsWith("/")) continue;
    const ctype: string = (prop?.getcontenttype ?? "").toString();
    if (!ctype.startsWith("image/")) continue;

    let name = href.split("/").filter(Boolean).pop() ?? "";
    try { name = decodeURIComponent(name); } catch { /* roher Name */ }
    if (!name) continue;

    const enc = encodeURIComponent(name);
    photos.push({
      name,
      thumb: `${base}/apps/files_sharing/publicpreview/${token}?file=${encodeURIComponent("/" + name)}&x=500&y=500&a=1`,
      full: `${base}/s/${token}/download?path=%2F&files=${enc}`,
      mtime: (prop?.getlastmodified ?? "").toString(),
    });
  }

  photos.sort((a, b) => {
    const ta = Date.parse(a.mtime) || 0;
    const tb = Date.parse(b.mtime) || 0;
    return tb - ta; // neueste zuerst
  });

  photoCache = { at: Date.now(), data: photos };
  return { photos };
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

    case "photos": {
      if (body.password !== SITE_PASSWORD) return fail(401, "invalid_password");
      const result = await listPhotos();
      if (result.error) {
        return fail(502, result.error, { status: result.status });
      }
      return ok({ photos: result.photos });
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
