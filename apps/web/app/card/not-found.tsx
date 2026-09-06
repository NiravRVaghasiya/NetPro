export default function CardNotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f3f5ef] px-6 text-center">
      <div className="max-w-md">
        <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-[#567164]">
          NetPro · Profile card
        </p>
        <h1 className="mb-4 text-3xl font-semibold tracking-tight text-[#183c30]">
          This card isn’t available.
        </h1>
        <p className="text-sm leading-7 text-[#526459]">
          The owner hasn’t published a card, or has taken it offline.
        </p>
        <a
          href="/"
          className="mt-7 inline-block text-sm font-medium text-[#24523e] underline underline-offset-4"
        >
          Back to NetPro
        </a>
      </div>
    </main>
  );
}
