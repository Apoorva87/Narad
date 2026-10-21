import { Component, type ReactNode } from 'react';

/** Keeps one failing view from blanking the whole app; reloading starts it fresh. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="page-error" role="alert"><h1>Something went wrong</h1><p>{this.state.error.message || 'This view stopped unexpectedly.'} Your library and lessons are saved.</p><button className="primary-button" onClick={() => location.reload()}>Reload Narad</button></div>;
  }
}
