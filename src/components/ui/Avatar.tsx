'use client';

interface AvatarProps {
  name: string;
  src?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClasses = {
  xs: 'w-5 h-5 text-[10px]',
  sm: 'w-6 h-6 text-xs',
  md: 'w-8 h-8 text-sm',
  lg: 'w-10 h-10 text-base',
};

function getInitials(name: string): string {
  return name
    .split(' ')
    .map(part => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    '#6366F1', '#8B5CF6', '#EC4899', '#EF4444', 
    '#F59E0B', '#10B981', '#06B6D4', '#3B82F6'
  ];
  return colors[Math.abs(hash) % colors.length];
}

export function Avatar({ name, src, size = 'md', className = '' }: AvatarProps) {
  const initials = getInitials(name);
  const bgColor = stringToColor(name);

  if (src) {
    return (
      <img 
        src={src} 
        alt={name}
        className={`${sizeClasses[size]} rounded-full object-cover ${className}`}
      />
    );
  }

  return (
    <div 
      className={`${sizeClasses[size]} rounded-full flex items-center justify-center font-medium text-white ${className}`}
      style={{ backgroundColor: bgColor }}
    >
      {initials}
    </div>
  );
}

// Avatar group for multiple users
interface AvatarGroupProps {
  users: { id: string; name: string; avatar?: string }[];
  max?: number;
  size?: 'xs' | 'sm' | 'md' | 'lg';
}

export function AvatarGroup({ users, max = 4, size = 'sm' }: AvatarGroupProps) {
  const visible = users.slice(0, max);
  const remaining = users.length - max;

  return (
    <div className="flex -space-x-2">
      {visible.map((user) => (
        <Avatar 
          key={user.id} 
          name={user.name} 
          src={user.avatar} 
          size={size}
          className="ring-2 ring-white"
        />
      ))}
      {remaining > 0 && (
        <div 
          className={`${sizeClasses[size]} rounded-full flex items-center justify-center font-medium bg-zinc-200 text-zinc-600 ring-2 ring-white`}
        >
          +{remaining}
        </div>
      )}
    </div>
  );
}
