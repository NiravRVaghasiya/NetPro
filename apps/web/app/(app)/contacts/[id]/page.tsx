export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div>
      <h1>Contact {id}</h1>
      <p>Coming soon.</p>
    </div>
  );
}
