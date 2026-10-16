# 040208
echo "current: $(readlink -f /srv/bambook-dev/current)"
echo "public: $(curl -s -o /dev/null -w %{http_code} https://bambook-dev.sylway.cloud/)"
