function timeHum(unixSec) {
  if (!unixSec) return "";
  if (unixSec < 0) return "0s";
  if (unixSec < 60) return `${unixSec}s`;
  if (unixSec < 3600) return `${Math.floor(unixSec/60)}m ${Math.floor((unixSec%60))}s`;
  if (unixSec < 86400) return `${Math.floor(unixSec/3600)}h ${Math.floor((unixSec%3600)/60)}m`;
  return `${Math.floor(unixSec/86400)}d ${Math.floor((unixSec%86400)/3600)}h`;
}
module.exports = { timeHum };
