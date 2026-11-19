import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import type { SyncCounts } from "@/lib/api";
import "./sync-notice.css";

export function SyncNotice({
  status,
  busy,
  retry,
}: {
  status: SyncCounts | null;
  busy: boolean;
  retry: () => void;
}) {
  if (!status) return null;
  const unavailable = Object.entries(status.unavailable);
  return (
    <div className="sync-notices">
      {!status.transactions_ready && (
        <section className="sync-preparing sync-notice" role="status">
          <LoaderCircle
            size={20}
            className={busy ? "spin" : undefined}
            aria-hidden="true"
          />
          <div>
            <h2>Transactions are still arriving</h2>
            <p>
              Plaid is preparing your transactions. Spending totals are not
              final and no new report has been calculated. Retry sync when
              you’re ready to check again.
            </p>
          </div>
          <button className="button secondary" disabled={busy} onClick={retry}>
            <RefreshCw size={15} className={busy ? "spin" : undefined} />
            Retry sync
          </button>
        </section>
      )}
      {unavailable.length > 0 && (
        <section className="sync-unavailable sync-notice" role="status">
          <CircleAlert size={20} aria-hidden="true" />
          <div>
            <h2>Some Plaid products are unavailable</h2>
            <ul>
              {unavailable.map(([product, code]) => (
                <li key={product}>
                  <strong>
                    {product === "holdings" ? "Holdings" : "Liabilities"} not
                    available from Plaid
                  </strong>{" "}
                  <code>{code}</code>
                </li>
              ))}
            </ul>
            <p>
              Previously saved information is unchanged. Unavailable products
              are not treated as zero.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
