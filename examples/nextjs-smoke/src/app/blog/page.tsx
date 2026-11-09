import Link from "next/link";
import { client } from "../../client.server";

export default async function BlogIndex() {
  const c = await client();
  // The posts' names and paths, from the index: no post body is read.
  const [posts, error] = await c.entries("post");
  if (error) throw error;
  return (
    <ul>
      {posts.flatMap((post) =>
        post.path === undefined ? [] : [<li key={post.path}><Link href={post.path}>{post.name}</Link></li>],
      )}
    </ul>
  );
}
