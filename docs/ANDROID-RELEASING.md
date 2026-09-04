# Android signed releases

## Current status

The upload identity is provisioned outside the repository, the protected
`releases` environment contains the four required secrets, and the first
combined Linux/Android workflow successfully built, verified and attested the
signed arm64 APK and AAB. The signed APK was also installed and launched on a
physical Android device. Clean-device acceptance and Play Store publication
remain separate future work.

Android release APKs and AABs use one long-lived upload identity. Losing that
identity prevents direct APK users from installing future versions as updates,
so create it once, back it up, and never commit or upload it as an artifact.

## Create the upload identity once

Use the JDK `keytool` interactively so the password does not appear in shell
history or process arguments:

```bash
install -d -m 700 "$HOME/.local/share/fyxtez-terminal/signing"
keytool -genkeypair -v \
  -keystore "$HOME/.local/share/fyxtez-terminal/signing/android-upload.jks" \
  -storetype PKCS12 \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -alias fyxtez-upload \
  -dname "CN=Fyxtez, O=Fyxtez, C=RS"
```

Use a randomly generated password stored in a password manager. Keep at least
two encrypted offline copies of the `.jks` file in different locations. Record
the SHA-256 certificate fingerprint shown by this command:

```bash
keytool -list -v \
  -keystore "$HOME/.local/share/fyxtez-terminal/signing/android-upload.jks" \
  -alias fyxtez-upload
```

Do not create a second identity for a later release. Google Play App Signing can
protect a separate store signing key, but direct APK upgrades still depend on
the certificate used for the APK being installed.

## Configure GitHub Actions

Create a protected GitHub Environment named `releases`, require the repository
owner's approval, and add these environment secrets:

| Secret                      | Value                                                    |
| --------------------------- | -------------------------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | Single-line base64 encoding of the complete `.jks` file  |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password                                        |
| `ANDROID_KEY_ALIAS`         | `fyxtez-upload`                                          |
| `ANDROID_KEY_PASSWORD`      | Private-key password; it may equal the keystore password |

Create the base64 value locally without producing a repository file:

```bash
base64 -w 0 < "$HOME/.local/share/fyxtez-terminal/signing/android-upload.jks"
```

Paste it directly into the GitHub secret field and clear the terminal. The
release workflow decodes it only into the ephemeral runner's temporary
directory and passes passwords to Gradle through masked environment secrets. It
verifies the alias, builds the signed arm64 APK/AAB, verifies both signatures,
and deletes the decoded keystore even after a failed build.

## Local signed build

Create the ignored file `frontend/src-tauri/gen/android/keystore.properties`:

```properties
storeFile=/absolute/path/to/android-upload.jks
storePassword=<from-password-manager>
keyAlias=fyxtez-upload
keyPassword=<from-password-manager>
```

Then build both formats:

```bash
cd frontend
npm run tauri -- android build --apk --aab --target aarch64 --ci
```

Release builds fail closed when this file is absent or incomplete. Development
continues to use `npm run android:build:device`, which creates a debug-signed APK
and does not require the release identity.

Verify the release output before distribution:

```bash
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose --print-certs \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
jarsigner -verify -strict \
  src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab
```

## Release and rollback

The `Signed Linux and Android release` workflow first builds, verifies, attests
and preserves both platform payloads as workflow artifacts. Only after both
platform jobs succeed does the final publish job create or update the draft and
attach the signed APK, signed AAB, Linux bundles and both SHA-256 manifests. A
failed platform build therefore does not create or modify a draft release. The
failed deployment entry GitHub records when a protected environment job starts
is an audit record, not a GitHub Release.

Never replace a published tag or reuse a version for corrected bytes. Withdraw
the affected release without deleting it, restore the last known-good signed
APK, and publish the fix under a higher patch version. Before any release,
compare the reported certificate fingerprint to the separately recorded value.
