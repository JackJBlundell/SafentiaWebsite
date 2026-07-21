// ============================================================================
// SiteFooter.
//
// The company facts here are the CLIENT's, not the Developer's: Firerite (UK)
// Limited is the company whose registered details appear on the site (Agreement,
// parties clause). Safentia is the product. Getting that the wrong way round on a
// public page would be a real misrepresentation, so the two are named explicitly.
//
// Every link points at a route that exists. The legal pages are part of the store
// submission obligation too (story 1078), so the privacy policy has a live URL.
// ============================================================================

import { Link } from "react-router-dom";
import { Wordmark } from "../components/Wordmark";
import { BRAND_TAGLINE } from "../design/brand";
import styles from "./SiteFooter.module.css";

/** Registered company details of the Client, as stated in the Agreement. */
const COMPANY = {
  legalName: "Firerite (UK) Limited",
  address: "Unit 14 Roundabout Court, Bedwas, Caerphilly CF83 8FS",
  email: "contact@safentia.co.uk",
} as const;

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { to: "/how-it-works", label: "How it works" },
      { to: "/faq", label: "FAQ" },
      { to: "/login", label: "Sign in" },
    ],
  },
  {
    heading: "Company",
    links: [
      { to: "/about", label: "About" },
      { to: "/news", label: "News" },
      { to: "/contact", label: "Contact" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { to: "/legal/privacy", label: "Privacy policy" },
      { to: "/legal/terms", label: "Terms of use" },
    ],
  },
] as const;

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          <Wordmark to="/" />
          <p className={styles.tagline}>{BRAND_TAGLINE}</p>
          <address className={styles.address}>
            {COMPANY.legalName}
            <br />
            {COMPANY.address}
            <br />
            <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>
          </address>
        </div>

        <div className={styles.columns}>
          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className={styles.columnHeading}>{column.heading}</h2>
              <ul className={styles.columnList}>
                {column.links.map((link) => (
                  <li key={link.to}>
                    <Link to={link.to} className={styles.columnLink}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>

      <div className={styles.baseline}>
        <div className={styles.baselineInner}>
          <p>
            &copy; {year} {COMPANY.legalName}. All rights reserved.
          </p>
          <p className={styles.note}>
            Safentia is software that supports fire risk assessment in line with
            the structure of PAS 79-1:2020. It is not fire-safety consultancy,
            and responsibility for compliance remains with the Responsible
            Person.
          </p>
        </div>
      </div>
    </footer>
  );
}
