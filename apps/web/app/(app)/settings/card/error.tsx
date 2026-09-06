"use client";

export default function CardEditorError({ reset }: { reset: () => void }) {
  return (
    <section className="mx-auto max-w-xl py-16">
      <h1 className="text-xl font-semibold">The card editor couldn’t load.</h1>
      <p className="my-4 text-sm text-slate-600">
        Please try again. If this continues, check the server’s database
        configuration and migrations.
      </p>
      <button
        onClick={reset}
        className="rounded-lg bg-[#214e3b] px-5 py-3 text-sm font-medium text-white"
      >
        Try again
      </button>
    </section>
  );
}
