import { redirect } from "next/navigation";
import { AdminLogin } from "@/components/admin-login";
import { isAdminAuthenticated } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await isAdminAuthenticated()) redirect("/admin");
  return <AdminLogin />;
}
