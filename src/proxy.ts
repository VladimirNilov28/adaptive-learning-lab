import { NextRequest, NextResponse } from "next/server";

const allowedHosts = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "100.83.57.5"
]);

export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const hostname = host.replace(/:\d+$/, "");
  if (!allowedHosts.has(hostname))
    return NextResponse.json({ error: "Only localhost requests are allowed" }, { status: 403 });
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin !== `http://${host}` && origin !== `https://${host}`)
      return NextResponse.json({ error: "A matching local Origin is required" }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
