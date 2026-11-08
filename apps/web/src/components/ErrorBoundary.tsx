import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StateMessage } from './StateMessage';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page render failed:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <StateMessage
          kind="error"
          actions={
            <button className="btn" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          }
        >
          This page failed to render: {this.state.error.message}
        </StateMessage>
      );
    }
    return this.props.children;
  }
}
