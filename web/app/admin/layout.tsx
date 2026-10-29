import AdminNav from "@/components/admin/AdminNav";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="wrap admin-shell">
      <AdminNav />
      <main className="admin-main">{children}</main>
    </div>
  );
}
