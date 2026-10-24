import Link from "next/link";
export default function NotFound() {
  return <div className="empty"><h1>Not found</h1><p>This learning item does not exist.</p><Link href="/">Back to dashboard →</Link></div>;
}
