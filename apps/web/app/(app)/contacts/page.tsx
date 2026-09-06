import { conn } from '@/lib/db';

async function getContacts() {
  // NOTE: `conn.db.select()` doesn't typecheck against the raw
  // `SqliteConn | PgConn` union — narrowing on `conn.dialect` is required.
  // Same pattern as packages/core's import/enrichment pipelines.
  if (conn.dialect === 'sqlite') {
    return conn.db.select().from(conn.schema.contacts).limit(50);
  }
  return conn.db.select().from(conn.schema.contacts).limit(50);
}

export default async function ContactsPage() {
  const contacts = await getContacts();

  return (
    <div>
      <h1>Contacts</h1>
      <a href="/api/export?format=csv">Export CSV</a>
      {contacts.length === 0 ? (
        <p>
          No contacts yet. <a href="/import">Import your connections</a> to get started.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Company</th>
              <th>Role</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id}>
                <td>{c.fullName}</td>
                <td>{c.company}</td>
                <td>{c.role}</td>
                <td>{c.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
