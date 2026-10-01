"use client";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="btn-ghost btn-icon btn-sm"
      title="Sign out"
      aria-label="Sign out"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        router.replace("/login");
        router.refresh();
      }}
    >
      <LogOut width={16} height={16} />
    </button>
  );
}
