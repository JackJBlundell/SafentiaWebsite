import { auth } from '../admin';
async function main() {
  const u = await auth.getUserByEmail('jordan.adminassessor@firerite-demo.test');
  console.log('uid:', u.uid);
  console.log('customClaims:', JSON.stringify(u.customClaims, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
