// ============================================================================
// Button - the one interactive control, in three weights.
//
// It renders a <button>, an <a> or a react-router <Link> depending on what it is
// asked to do, because a control that navigates must be a link (right-click, open
// in new tab, and the screen reader's link rota all depend on it) and a control
// that acts must be a button. Getting this wrong is the single most common
// accessibility fault on a marketing site, so the component decides, not the
// caller's styling.
//
// Every variant clears a 44px minimum target (MIN_TOUCH_TARGET).
// ============================================================================

import React from 'react';
import { Link } from 'react-router-dom';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'md' | 'lg';

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretches to the width of its container. Used in narrow forms. */
  block?: boolean;
  children: React.ReactNode;
  className?: string;
}

type ButtonAsButton = CommonProps &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps> & {
    to?: undefined;
    href?: undefined;
  };

type ButtonAsLink = CommonProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> & {
    /** An in-app route. Renders a react-router Link, so navigation is client-side. */
    to: string;
    href?: undefined;
  };

type ButtonAsAnchor = CommonProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> & {
    /** An external or non-router URL. Renders a plain anchor. */
    href: string;
    to?: undefined;
  };

export type ButtonProps = ButtonAsButton | ButtonAsLink | ButtonAsAnchor;

export function Button(props: ButtonProps) {
  const {
    variant = 'primary',
    size = 'md',
    block = false,
    children,
    className = '',
    ...rest
  } = props;

  const classes = [
    styles.button,
    styles[variant],
    styles[size],
    block ? styles.block : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  if ('to' in props && props.to !== undefined) {
    const { to, ...anchorRest } = rest as ButtonAsLink;
    return (
      <Link to={to} className={classes} {...anchorRest}>
        {children}
      </Link>
    );
  }

  if ('href' in props && props.href !== undefined) {
    const anchorRest = rest as React.AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a className={classes} {...anchorRest}>
        {children}
      </a>
    );
  }

  const buttonRest = rest as React.ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    // An explicit type: a <button> inside a <form> defaults to submit, which is
    // a real bug the day someone drops a secondary action into a form.
    <button type={buttonRest.type ?? 'button'} className={classes} {...buttonRest}>
      {children}
    </button>
  );
}
