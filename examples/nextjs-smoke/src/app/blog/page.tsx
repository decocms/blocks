import Link from "next/link";
import { client } from "../../client.server";
import type { Post } from "../../post";

export default async function BlogIndex() {
  const c = await client();
  const [posts, error] = await c.list<Post>("post", { sort: (a, b) => b.date.localeCompare(a.date) });
  if (error) throw error;
  return (
    <ul>
      {posts.map((post) => (
        <li key={post.path}><Link href={post.path}>{post.name}</Link></li>
      ))}
    </ul>
  );
}
