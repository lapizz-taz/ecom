import { page } from "@/lib/links";

export default function NotFound() {
  return (
    <section className="section bg-white">
      <div className="container-page max-w-[560px] text-center">
        <p className="eyebrow">Error 404</p>
        <h1 className="h1 mt-3">This page flew away</h1>
        <p className="lead mt-4">The page you&apos;re looking for doesn&apos;t exist. Let&apos;s get you back on track.</p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <a href={page("/")} className="btn btn-primary">Go home</a>
          <a href={page("/#register")} className="btn btn-secondary">Register Now</a>
        </div>
      </div>
    </section>
  );
}
