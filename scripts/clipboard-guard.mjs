import policy from './clipboard-policy.cjs';
if (!policy.githubActions(process.env)) {
  console.error(policy.reason);
  process.exit(1);
}
