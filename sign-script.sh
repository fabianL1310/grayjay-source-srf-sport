#!/bin/sh
#Example usage:
#cat script.js | sign-script.sh
#sh sign-script.sh script.js

#Set your key paths here
#Generated with `ssh-keygen -t rsa -b 4096 -m PEM -N "" -f ./.ssh/id_rsa`
PRIVATE_KEY_PATH=./.ssh/id_rsa
PUBLIC_KEY_PATH=./.ssh/id_rsa.pub

#Set the config file to update
CONFIG_PATH=./config.json

PUBLIC_KEY_PKCS8=$(ssh-keygen -f "$PUBLIC_KEY_PATH" -e -m pkcs8 | tail -n +2 | head -n -1 | tr -d '\n')
echo "This is your public key: '$PUBLIC_KEY_PKCS8'"

if [ $# -eq 0 ]; then
  # No parameter provided, read from stdin
  SIGNATURE=$(openssl dgst -sha512 -sign "$PRIVATE_KEY_PATH" | base64 -w 0)
else
  # Parameter provided, sign the file's raw bytes (preserves trailing newline)
  SIGNATURE=$(openssl dgst -sha512 -sign "$PRIVATE_KEY_PATH" < "$1" | base64 -w 0)
fi
echo "This is your signature: '$SIGNATURE'"

# Write the public key and signature into the config file
if [ -n "$SIGNATURE" ]; then
  # base64 only contains A-Z a-z 0-9 + / = so '|' is a safe sed delimiter
  sed -i \
    -e "s|\(\"scriptSignature\": \"\)[^\"]*\"|\1$SIGNATURE\"|" \
    -e "s|\(\"scriptPublicKey\": \"\)[^\"]*\"|\1$PUBLIC_KEY_PKCS8\"|" \
    "$CONFIG_PATH"
  echo "Updated $CONFIG_PATH"
else
  echo "Signature was empty; $CONFIG_PATH not updated"
fi
