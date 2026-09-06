import { conn } from "@/lib/db";
import { getPublishedCard } from "@netpro/core/src/card/repository";
import { renderProfileVCard } from "@netpro/core/src/card/vcard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

export async function GET(): Promise<Response> {
  try {
    const profile = await getPublishedCard(conn);
    if (!profile)
      return Response.json(
        { error: "Card not found." },
        { status: 404, headers },
      );
    return new Response(renderProfileVCard(profile), {
      headers: {
        ...headers,
        "Content-Type": "text/vcard; charset=utf-8",
        // Constant filename — never put user-controlled text into response headers.
        "Content-Disposition": 'attachment; filename="contact.vcf"',
      },
    });
  } catch {
    return Response.json(
      { error: "Unable to load the card." },
      { status: 500, headers },
    );
  }
}
