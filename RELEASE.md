# Release guide for agents

Use this guide when the user requests a new Lunar Spice version or a release. Write the
version changes locally. GitHub Actions builds the desktop packages and deploys the web
app after the version tag is pushed. A push to `master` alone neither releases nor deploys
anything.

## 1. Select the version

Read [AGENTS.md](AGENTS.md), [GLOSSARY.md](GLOSSARY.md), the
[desktop package](apps/desktop/package.json), the [web package](apps/web/package.json) and
the [release workflow](.github/workflows/release.yml). Check `git status` and preserve
unrelated changes. Fetch tags and list the released versions:

```sh
git fetch origin --tags
git tag --list 'v*' --sort=-version:refname
```

Use `0.1.x` numbering. Choose the next unused patch number above every existing `0.1.x`
release or tag, starting with `0.1.0` for the first release. For each subsequent release,
keep `0.1` and increase `x` by one: `0.1.0` → `0.1.1` → `0.1.2`. This sequence applies to
fixes, new features and breaking changes; document any required migration in the release
notes. Change the numbering scheme only when the user explicitly requests it.

When the user supplies a version, confirm it is unused and higher than the latest released
version. Documentation changes alone do not require a version bump unless the user
requests a release. Preserve historical releases and tags.

The packaging tool requires three numbers, such as `0.1.0`. If the user requests a version
with four numbers, agree on a supported version before changing it or publishing the
release.

Every tag `v0.1.x` deploys that commit's web app to `lunarspice.doctorthe113.com`. There
is no tag suffix.

The desktop app is not being developed right now, so the `build` job in the release
workflow is commented out and releases publish no desktop packages. Still set the desktop
version with the web one; the check job compares both with the tag. While the builds are
paused, skip the steps below that wait for or check desktop assets.

This step is complete when the selected version and the reason for the increase are clear.
The examples below use `0.1.0`. Replace it with the selected version.

## 2. Prepare the version changes

1. Set the selected version, without `v`, in both packages:
   - `version` in `apps/desktop/package.json`
   - `version` in `apps/web/package.json`
2. Run `bun install` from the project root to update the workspace versions in `bun.lock`.
   Review the diff for unrelated dependency changes.
3. Draft the release notes for direct publication on the GitHub release. Describe each
   change in short, everyday sentences that explain what users can now do or what problem
   was fixed. Use no technical jargon, code names or commit lists. For example: "Fixed a
   problem where a saved circuit opened with the wrong zoom." Include any steps users need
   to take after updating. Keep the draft in the conversation; create no changelog or
   release-notes files.
4. Update the readme or feature docs for changed behavior.
5. Run the repository checks:

   ```sh
   bun run format
   bun run lint
   bun run check-types
   bun run test
   ```

6. Review the final diff. Confirm that both versions and the lockfile workspace versions
   match, and that the drafted notes describe all changes since the previous release.

The app release version belongs to `apps/desktop/package.json` and
`apps/web/package.json`; the web About dialog shows the latter. The root catalog stores
dependency versions. Shared package versions do not need to change for an app release.

GitHub Actions runs the checks again, packages Linux x86_64 and macOS Apple Silicon, and
deploys the web app. Each package job publishes its asset to the GitHub release as soon as
it finishes, so a slow or failed platform does not hold back the other;
`.github/scripts/publish-asset.sh` creates the release on the first upload. Use this
automated build for a release. A local package build is only needed when the user requests
it or when diagnosing a packaging failure.

This step is complete when the version changes are ready for review and all local checks
pass. If commit or push approval is needed under `AGENTS.md`, request it now. Use existing
user authorization when it covers these actions.

## 3. Commit and push the release tag

Commit on the current branch. Include the intended release changes and exclude unrelated
user changes. If the app changes are already committed, the version commit can use:

```sh
release_version=0.1.0
release_tag="v$release_version"
git add apps/desktop/package.json apps/web/package.json bun.lock
git commit -m "Release $release_tag"
git push origin HEAD
git tag -a "$release_tag" -m "Lunar Spice $release_tag"
git push origin "$release_tag"
```

Stage any requested documentation changes explicitly before the commit. If another agent
has changes in a package or the lockfile, stage only the release version hunks in those
files and leave its changes uncommitted. Review the complete staged diff before
committing. Create the tag on the commit that contains the complete release. The tag must
be `v` followed by the exact desktop and web package version. The workflow rejects a
mismatch.

This step is complete when the release commit and its tag are on GitHub and the Release
workflow has started.

## 4. Verify publication

Find the run for the pushed tag:

```sh
gh run list --workflow release.yml --branch "$release_tag" --limit 5
```

Use its run ID to monitor it:

```sh
gh run watch RUN_ID --exit-status
gh release view "$release_tag"
```

Replace `RUN_ID` with the selected run ID. Confirm that the check job, both build jobs and
the `deploy-web` job pass. The release appears after the first build finishes and gains
each asset as its job finishes. While the desktop builds are paused, only the check and
`deploy-web` jobs run and no release appears; create it with the notes instead:
`gh release create "$release_tag" --verify-tag --title "$release_tag" --notes "<release notes>"`.
Otherwise confirm that the release contains:

- `lunar-spice-linux-x64.zip`
- `lunar-spice-macos-arm64.dmg`

Confirm that the deploy job reported `https://lunarspice.doctorthe113.com` and that the
site answers:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://lunarspice.doctorthe113.com/
```

Once the release exists, even while a build is still running, apply the prepared notes
directly to it with `gh release edit "$release_tag" --notes "<release notes>"`, replacing
the placeholder with the full draft and preserving its Markdown and line breaks. The
workflow publishes the assets without changing existing release notes; a new release
starts with empty notes. Run `gh release view "$release_tag"` again and confirm that the
published notes match the draft and use everyday language.

If one build fails, the release keeps the assets of the builds that passed. Rerun the
failed job with `gh run rerun RUN_ID --failed`; it adds its asset to the same release.

This step is complete when the run passes, all expected assets are published, the web app
serves the new version, and the release notes match the prepared draft. Report the
version, release URL and workflow result. If a job fails, report the failure and resolve
it before claiming that the release is complete.

## Roll back the web app

The web app deploys from the tagged commit, and Alchemy keeps each Worker version. To undo
a bad web change, revert the commit, bump the version and release a new tag; do not deploy
an older tag over a newer one. The desktop packages and the web app always share a
version.

## Repository secrets

| Secret                  | Used by      |
| ----------------------- | ------------ |
| `CLOUDFLARE_API_TOKEN`  | `deploy-web` |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy-web` |

The token needs Workers Scripts Edit, Workers Routes Edit, Secrets Store Read, Account
Settings Read, and Zone Read and DNS Edit on `doctorthe113.com`. Workers Routes and DNS
attach the custom domain that Cloudflare creates for the Worker.

## Rebuild an existing release

For a temporary runner or network failure, rerun the failed jobs for the same commit. For
an intentional rebuild, the workflow supports manual dispatch:

```sh
gh workflow run release.yml --ref "$release_tag" -f tag="$release_tag"
```

Set `release_tag` to the existing tag first. That tag must contain a workflow with
`workflow_dispatch` support. The `--ref` selects the code to build; the `tag` input
selects the release to update. Keep them equal when rebuilding the same release. Each
build replaces the existing asset with the same name and preserves the release notes
already on GitHub. If the user requests changes to those notes, apply them directly with
`gh release edit --notes` after the rebuild succeeds. A manual dispatch also re-runs the
web deploy.

Use a new version for app source changes after publication. Preserve published tags. If an
older tag lacks manual dispatch support, report that limitation and prepare a new version
for the corrected source or workflow.
