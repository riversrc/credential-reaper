import { SecurityActivity } from '../components/SecurityActivity';

export function Activity() {
  return (
    <>
      <div className="page-header">
        <h1>Activity</h1>
        <p>Security events as the app recorded them: observed facts, AI findings and user actions.</p>
      </div>
      <SecurityActivity />
    </>
  );
}
